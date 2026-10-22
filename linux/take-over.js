import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, stat } from "node:fs/promises"
import path from "node:path"

import { getScope } from "../protocol/index.js"

import { assertRestoreOwnersNotLive, validateRestoreName } from "./restore.js"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

function requireSafeString(value, label) {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label} is missing or contains terminal control characters.`)
  }
  return value
}

function shellQuote(value, label) {
  requireSafeString(value, label)
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function requireRegularFile(
  file,
  { nonempty = false, readable = false, rejectSymlink = false } = {}
) {
  const info = rejectSymlink ? await lstat(file) : await stat(file)
  if (info.isSymbolicLink() || !info.isFile() || (nonempty && info.size === 0)) {
    throw new Error(`Required file is missing, empty, or not a regular file: ${file}`)
  }
  if (readable) {
    await access(file, constants.R_OK)
  }
}

async function requireDirectory(directory, { rejectSymlink = false } = {}) {
  const info = rejectSymlink ? await lstat(directory) : await stat(directory)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Current session directory is not a directory: ${directory}`)
  }
  await access(directory, constants.R_OK | constants.X_OK)
}

async function isExecutableFile(file) {
  try {
    const info = await stat(file)
    if (!info.isFile()) {
      return false
    }
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findExecutableOnPath(env) {
  const searchPath = env.PATH
  if (typeof searchPath !== "string") {
    throw new Error("Unable to find ompi because PATH is unavailable.")
  }

  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.resolve(process.cwd(), directory || ".", "ompi")
    if (await isExecutableFile(candidate)) {
      return candidate
    }
  }

  throw new Error("Unable to find an executable ompi on PATH.")
}

async function resolveExecutable(env, executable) {
  if (executable === undefined) {
    return findExecutableOnPath(env)
  }
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("The injected ompi executable path is invalid.")
  }

  const absolutePath = path.resolve(process.cwd(), executable)
  if (!(await isExecutableFile(absolutePath))) {
    throw new Error(
      `The injected ompi executable is unavailable or not executable: ${absolutePath}`
    )
  }
  return absolutePath
}

async function requireControlRestoreVersion(executable, scope, env) {
  let result
  try {
    result = await new Promise((resolve, reject) => {
      execFile(
        executable,
        ["control", "--version"],
        {
          env: {
            ...env,
            PI_CONFIG_DIR: scope.configRoot,
            PI_PROFILE: scope.profile,
            PI_CODING_AGENT_DIR: scope.agentDir,
          },
          timeout: 2_000,
          maxBuffer: 16 * 1024,
        },
        (error, stdout) => {
          if (error) reject(error)
          else resolve(stdout)
        }
      )
    })
  } catch (error) {
    throw new Error(`Unable to verify native ompi managed-restore support: ${error.message}`, {
      cause: error,
    })
  }
  const version = /^ompi (\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    result.trim()
  )
  if (!version) {
    throw new Error(
      "Native ompi 0.12.0 or newer is required; no verifiable controller version was reported."
    )
  }
  const [major, minor, patch] = version.slice(1, 4).map(Number)
  const supported =
    major > 0 ||
    (major === 0 && minor > 12) ||
    (major === 0 && minor === 12 && patch >= 0 && version[4] === undefined)
  if (!supported)
    throw new Error(
      `Native ${version[0]} does not support control restore; version 0.12.0 or newer is required.`
    )
}

function recoveryEnvironmentArguments(scope) {
  const args = [
    "-u PI_CODING_AGENT_DIR",
    `PI_CONFIG_DIR=${shellQuote(scope.configRoot, "Configuration directory")}`,
    `OMP_PROFILE=${shellQuote(scope.profile, "Profile")}`,
  ]
  if (scope.profile === "default") {
    args.push(`PI_CODING_AGENT_DIR=${shellQuote(scope.agentDir, "Agent directory")}`)
  }
  return args.join(" ")
}

function environmentArguments(env, scope) {
  const args = ["-u OMP_PROFILE", "-u PI_CODING_AGENT_DIR", "-u XDG_RUNTIME_DIR"]

  args.push(
    `PI_CONFIG_DIR=${shellQuote(scope.configRoot, "Configuration directory")}`,
    `PI_PROFILE=${shellQuote(scope.profile, "Profile")}`
  )
  if (scope.profile === "default") {
    args.push(`PI_CODING_AGENT_DIR=${shellQuote(scope.agentDir, "Agent directory")}`)
  }

  if (env.XDG_RUNTIME_DIR !== undefined) {
    if (env.XDG_RUNTIME_DIR && !path.isAbsolute(env.XDG_RUNTIME_DIR)) {
      throw new Error("XDG_RUNTIME_DIR must be an absolute path.")
    }

    args.push(`XDG_RUNTIME_DIR=${shellQuote(env.XDG_RUNTIME_DIR, "XDG runtime directory")}`)
  }

  return args.join(" ")
}

export async function prepareResumeCommand(
  { sessionFile, cwd },
  { env = process.env, executable } = {}
) {
  if (process.platform !== "linux") {
    throw new Error("Take-over is only supported on Linux.")
  }

  requireSafeString(sessionFile, "Persisted session file")
  requireSafeString(cwd, "Current session directory")
  if (!path.isAbsolute(sessionFile)) {
    throw new Error("The current session file path is not absolute.")
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("The current session directory path is not absolute.")
  }

  const scope = getScope({ env, cwd: process.cwd() })
  await requireRegularFile(sessionFile, { nonempty: true, readable: true })
  await requireDirectory(cwd)
  const absoluteExecutable = await resolveExecutable(env, executable)

  const environment = environmentArguments(env, scope)

  return `cd ${shellQuote(cwd, "Current session directory")} && env ${environment} ${shellQuote(absoluteExecutable, "ompi executable")} --profile=${shellQuote(scope.profile, "Profile")} -r ${shellQuote(sessionFile, "Persisted session file")}`
}

export async function prepareNamedRestoreCommand(
  scope,
  name,
  session,
  { env = process.env, executable } = {}
) {
  if (process.platform !== "linux") {
    throw new Error("Named restore is only supported on Linux.")
  }
  validateRestoreName(name)
  await assertRestoreOwnersNotLive(session.owner, session.agentOwner)
  if (
    session.scope?.id !== scope.id ||
    session.scope?.configRoot !== scope.configRoot ||
    session.scope?.profile !== scope.profile ||
    session.scope?.agentDir !== scope.agentDir
  ) {
    throw new Error("Saved session belongs to a different OMP scope.")
  }

  requireSafeString(session.sessionFile, "Persisted session file")
  requireSafeString(session.cwd, "Saved session directory")
  if (!path.isAbsolute(session.sessionFile) || !path.isAbsolute(session.cwd)) {
    throw new Error("Saved session paths must be absolute.")
  }
  await requireRegularFile(session.sessionFile, {
    nonempty: true,
    readable: true,
    rejectSymlink: true,
  })
  await requireDirectory(session.cwd, { rejectSymlink: true })
  const absoluteExecutable = await resolveExecutable(env, executable)

  await requireControlRestoreVersion(absoluteExecutable, scope, env)
  const environment = recoveryEnvironmentArguments(scope)

  return `cd ${shellQuote(session.cwd, "Saved session directory")} && env ${environment} ${shellQuote(absoluteExecutable, "ompi executable")} control restore ${shellQuote(name, "Restore name")} --profile=${shellQuote(scope.profile, "Profile")}`
}

export async function prepareSlotRestoreCommand(
  scope,
  restoreId,
  session,
  { env = process.env, executable, assertOwnersNotLive: checkOwners = true } = {}
) {
  if (process.platform !== "linux") {
    throw new Error("Managed slot restore is only supported on Linux.")
  }
  if (!/^[a-f0-9]{32}$/.test(restoreId ?? "")) {
    throw new Error("Invalid managed restore slot identity.")
  }
  if (checkOwners) await assertRestoreOwnersNotLive(session.owner, session.agentOwner)
  if (
    session.scope?.id !== scope.id ||
    session.scope?.configRoot !== scope.configRoot ||
    session.scope?.profile !== scope.profile ||
    session.scope?.agentDir !== scope.agentDir
  ) {
    throw new Error("Saved session belongs to a different OMP scope.")
  }
  requireSafeString(session.sessionFile, "Persisted session file")
  requireSafeString(session.cwd, "Saved session directory")
  if (!path.isAbsolute(session.sessionFile) || !path.isAbsolute(session.cwd)) {
    throw new Error("Saved session paths must be absolute.")
  }
  await requireRegularFile(session.sessionFile, {
    nonempty: true,
    readable: true,
    rejectSymlink: true,
  })
  await requireDirectory(session.cwd, { rejectSymlink: true })
  const absoluteExecutable = await resolveExecutable(env, executable)
  await requireControlRestoreVersion(absoluteExecutable, scope, env)
  const environment = recoveryEnvironmentArguments(scope)
  return `cd ${shellQuote(session.cwd, "Saved session directory")} && env ${environment} ${shellQuote(absoluteExecutable, "ompi executable")} control restore --slot ${shellQuote(restoreId, "Restore identity")} --profile=${shellQuote(scope.profile, "Profile")}`
}

export async function prepareLegacyRecoveryExportCommand(
  scope,
  legacy,
  { env = process.env, executable } = {}
) {
  if (!path.isAbsolute(legacy.cwd) || !path.isAbsolute(legacy.sessionFile)) {
    throw new Error("Legacy session paths must be absolute.")
  }
  requireSafeString(legacy.cwd, "Legacy session directory")
  requireSafeString(legacy.sessionFile, "Legacy session file")
  await requireDirectory(legacy.cwd, { rejectSymlink: true })
  await requireRegularFile(legacy.sessionFile, {
    nonempty: true,
    readable: true,
    rejectSymlink: true,
  })
  const absoluteExecutable = await resolveExecutable(env, executable)
  const environment = recoveryEnvironmentArguments(scope)
  return `cd ${shellQuote(legacy.cwd, "Legacy session directory")} && env ${environment} ${shellQuote(absoluteExecutable, "ompi executable")} -r ${shellQuote(legacy.sessionFile, "Legacy session file")}`
}
