import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import path from "node:path"

import { getScope } from "../protocol/index.js"

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

async function requireRegularFile(file, { nonempty = false, readable = false } = {}) {
  const info = await stat(file)
  if (!info.isFile() || (nonempty && info.size === 0)) {
    throw new Error(`Required file is missing, empty, or not a regular file: ${file}`)
  }
  if (readable) {
    await access(file, constants.R_OK)
  }
}

async function requireDirectory(directory) {
  const info = await stat(directory)
  if (!info.isDirectory()) {
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

function assertSessionUnchanged(ctx, sessionId, sessionFile, cwd) {
  if (
    ctx.sessionManager.getSessionId() !== sessionId ||
    ctx.sessionManager.getSessionFile() !== sessionFile ||
    ctx.cwd !== cwd
  ) {
    throw new Error("The active session changed while preparing its resume command.")
  }
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

export async function prepareTakeover(ctx, { env = process.env, executable } = {}) {
  if (process.platform !== "linux") {
    throw new Error("Take-over is only supported on Linux.")
  }

  const sessionManager = ctx?.sessionManager
  if (!sessionManager) {
    throw new Error("The current session cannot be resumed.")
  }

  const sessionId = sessionManager.getSessionId()
  const sessionFile = sessionManager.getSessionFile()
  const cwd = ctx.cwd

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("The current session has no persisted session identity.")
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

  assertSessionUnchanged(ctx, sessionId, sessionFile, cwd)

  const environment = environmentArguments(env, scope)

  return `cd ${shellQuote(cwd, "Current session directory")} && env ${environment} ${shellQuote(absoluteExecutable, "ompi executable")} --profile=${shellQuote(scope.profile, "Profile")} -r ${shellQuote(sessionFile, "Persisted session file")}`
}
