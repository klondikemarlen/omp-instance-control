import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { access, mkdir, rm, stat, unlink } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  ensurePrivateDirectory,
  getRuntimeRoot,
  readPrivateJson,
  writePrivateJson,
} from "./transport.js"
import { getScope } from "../protocol/index.js"

const EXTENSION_PATH = fileURLToPath(new URL("../omp/index.js", import.meta.url))
const LAUNCH_DIR_ENV = "OMP_INSTANCE_CONTROL_LAUNCH_DIR"
const LAUNCH_TOKEN_ENV = "OMP_INSTANCE_CONTROL_LAUNCH_TOKEN"

export async function launchOmp(options = {}) {
  if (process.platform !== "linux") {
    throw new Error("The OMP instance-control launcher currently supports Linux only.")
  }
  if (!options.allowNonTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("Interactive OMP launch requires a TTY.")
  }

  const cwd = resolve(options.cwd ?? process.cwd())
  const cwdInfo = await stat(cwd)
  if (!cwdInfo.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`)
  options = {
    ...options,
    config: (options.config ?? []).map((file) => resolve(cwd, file)),
    extension: (options.extension ?? []).map((file) => resolve(cwd, file)),
    sessionDir: options.sessionDir ? resolve(cwd, options.sessionDir) : undefined,
  }
  process.chdir(cwd)

  const env = process.env
  const scope = getScope({ env, profile: options.profile, cwd })
  const root = await getRuntimeRoot(env)
  await ensurePrivateDirectory(root)
  const launchDirectory = join(root, `launch-${process.pid}-${randomToken()}`)
  await mkdir(launchDirectory, { mode: 0o700 })
  await ensurePrivateDirectory(launchDirectory)

  const launchFile = join(launchDirectory, "launch.json")
  const handoffFile = join(launchDirectory, "handoff.json")
  const executable = env.OMP_INSTANCE_CONTROL_OMP || "omp"

  let nextResume = null
  let lastRestart = null
  let exitCode = 0
  let receivedSignal = null
  try {
    while (true) {
      const token = randomToken()
      const launchRecord = {
        version: 1,
        token,
        pid: process.pid,
        scope,
        extensionPath: EXTENSION_PATH,
        lastRestart,
      }
      const launchEnv = {
        ...env,
        [LAUNCH_DIR_ENV]: launchDirectory,
        [LAUNCH_TOKEN_ENV]: token,
      }
      await removeIfExists(handoffFile)
      await writePrivateJson(launchFile, launchRecord)
      const argv = composeArguments(options, nextResume, process.cwd())
      const result = await runChild(executable, argv, launchEnv, (signal) => {
        receivedSignal = signal
      })
      if (result.signal || receivedSignal) {
        exitCode = 128 + signalNumber(result.signal ?? receivedSignal)
        break
      }
      if (result.code !== 0) {
        exitCode = result.code ?? 1
        break
      }

      const handoff = await readHandoff(handoffFile, token)
      if (!handoff) break
      await unlink(handoffFile)
      await access(handoff.sessionFile)
      const sessionInfo = await stat(handoff.sessionFile)
      if (!sessionInfo.isFile()) throw new Error("Restart handoff session is not a regular file.")
      const directoryInfo = await stat(handoff.cwd)
      if (!directoryInfo.isDirectory())
        throw new Error("Restart handoff working directory is not a directory.")
      process.chdir(handoff.cwd)
      lastRestart = {
        operationId: handoff.operationId,
        previousInstanceId: handoff.instanceId,
      }
      nextResume = handoff.sessionFile
    }
  } finally {
    await rm(launchDirectory, { recursive: true, force: true })
  }
  return exitCode
}

function composeArguments(options, resumeFile, currentCwd) {
  const args = ["--extension", EXTENSION_PATH]
  addOption(args, "--profile", options.profile)
  addOption(args, "--cwd", currentCwd)
  addOption(args, "--model", options.model)
  addOption(args, "--thinking", options.thinking)
  for (const config of options.config ?? []) addOption(args, "--config", config)
  for (const extension of options.extension ?? []) addOption(args, "--extension", extension)
  addOption(args, "--session-dir", options.sessionDir)
  for (const [key, flag] of [
    ["noTitle", "--no-title"],
    ["noLsp", "--no-lsp"],
    ["noPty", "--no-pty"],
    ["noTools", "--no-tools"],
    ["noSkills", "--no-skills"],
    ["noRules", "--no-rules"],
  ]) {
    if (options[key]) args.push(flag)
  }
  if (resumeFile ?? options.resume) addOption(args, "--resume", resumeFile ?? options.resume)
  if (!resumeFile) args.push(...(options.messages ?? []))
  return args
}

function addOption(args, name, value) {
  if (value === undefined || value === null || value === false) return
  args.push(name, String(value))
}

function randomToken() {
  return randomBytes(16).toString("hex")
}

async function removeIfExists(path) {
  try {
    await unlink(path)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

async function readHandoff(path, token) {
  let handoff
  try {
    handoff = await readPrivateJson(path)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  if (
    handoff?.version !== 1 ||
    handoff.token !== token ||
    typeof handoff.operationId !== "string" ||
    handoff.operationId.length === 0 ||
    handoff.operationId.length > 128 ||
    !/^[0-9a-f]{32}$/.test(handoff.instanceId) ||
    typeof handoff.sessionFile !== "string" ||
    !isAbsolute(handoff.sessionFile) ||
    typeof handoff.cwd !== "string" ||
    !isAbsolute(handoff.cwd)
  ) {
    throw new Error("Invalid restart handoff; refusing to resume.")
  }
  return handoff
}

async function runChild(executable, args, env, onSignal) {
  const child = spawn(executable, args, { stdio: "inherit", env })
  const handlers = new Map()
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      onSignal(signal)
      if (!child.killed) child.kill(signal)
    }
    handlers.set(signal, handler)
    process.once(signal, handler)
  }
  try {
    const { promise, resolve, reject } = Promise.withResolvers()
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
    return await promise
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 1
}
