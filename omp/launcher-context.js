import { randomBytes } from "node:crypto"
import { renameSync, writeFileSync } from "node:fs"
import { open, unlink } from "node:fs/promises"
import path from "node:path"

import { normalizePRResumeURL } from "../linux/pr-resume.js"
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "../linux/transport.js"
import { ProtocolError, PROTOCOL_VERSION, validateInstanceId } from "../protocol/index.js"

export async function readLauncherContext(env = process.env) {
  const directory = env.OMP_INSTANCE_CONTROL_LAUNCH_DIR
  const token = env.OMP_INSTANCE_CONTROL_LAUNCH_TOKEN
  if (!directory || !token) return null
  validateInstanceId(token)
  await ensurePrivateDirectory(directory)
  const launch = await readPrivateJson(path.join(directory, "launch.json"))
  if (
    launch.version !== PROTOCOL_VERSION ||
    launch.token !== token ||
    launch.pid !== process.ppid
  ) {
    throw new ProtocolError(
      "INVALID_LAUNCHER",
      "Launcher identity does not match this OMP process."
    )
  }
  if (!launch.scope || !/^[a-f0-9]{16}$/.test(launch.scope.id)) {
    throw new ProtocolError("INVALID_LAUNCHER", "Launcher configuration scope is invalid.")
  }
  if (typeof launch.extensionPath !== "string" || !path.isAbsolute(launch.extensionPath)) {
    throw new ProtocolError("INVALID_LAUNCHER", "Launcher extension path is invalid.")
  }
  if (launch.canRestartWrapper !== undefined && typeof launch.canRestartWrapper !== "boolean") {
    throw new ProtocolError("INVALID_LAUNCHER", "Launcher wrapper-restart capability is invalid.")
  }
  if (launch.canFreshLaunch !== undefined && typeof launch.canFreshLaunch !== "boolean") {
    throw new ProtocolError("INVALID_LAUNCHER", "Launcher fresh-launch capability is invalid.")
  }
  if (launch.restartError !== undefined && typeof launch.restartError !== "string") {
    throw new ProtocolError("INVALID_LAUNCHER", "Launcher restart limitation is invalid.")
  }
  if (
    !Array.isArray(launch.builtinFlags) ||
    launch.builtinFlags.some((name) => typeof name !== "string" || !name)
  ) {
    throw new ProtocolError("INVALID_LAUNCHER", "Launcher built-in flag names are invalid.")
  }
  if (
    launch.prResume !== undefined &&
    (normalizePRResumeURL(launch.prResume?.url) !== launch.prResume?.url ||
      typeof launch.prResume?.url !== "string" ||
      typeof launch.prResume.cwd !== "string" ||
      !path.isAbsolute(launch.prResume.cwd))
  ) {
    throw new ProtocolError("INVALID_LAUNCHER", "Launcher PR resume request is invalid.")
  }

  const handoffPath = path.join(directory, "handoff.json")
  try {
    const previous = await readPrivateJson(handoffPath)
    if (previous.token !== token) {
      throw new ProtocolError(
        "INVALID_HANDOFF",
        "A handoff from another launch cannot be consumed."
      )
    }
    // Native /restart can replace OMP without exiting the launcher child. Its
    // new plugin binding consumes an old handoff so a later /exit cannot replay it.
    await unlink(handoffPath)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  return { ...launch, directory, handoffPath }
}

export async function claimLaunchPRResume(launch) {
  // An upstream /restart can rebind the extension without stopping ompi.
  // A private exclusive claim prevents the same launch request being staged twice.
  let claim
  try {
    claim = await open(path.join(launch.directory, "pr-resume.claim"), "wx", 0o600)
  } catch (error) {
    if (error.code === "EEXIST") {
      return false
    }
    throw error
  }
  await claim.close()
  return true
}

export async function recordLaunchPRResumeResult(launch, { status, message }) {
  if (process.ppid !== launch.pid) {
    throw new ProtocolError("LAUNCHER_GONE", "The owning launcher is no longer attached.")
  }

  await writePrivateJson(path.join(launch.directory, "pr-resume-result.json"), {
    version: PROTOCOL_VERSION,
    token: launch.token,
    status,
    message,
  })
}

export async function recordLaunchRegistration(launch, scope, instanceId) {
  if (process.ppid !== launch.pid) {
    throw new ProtocolError("LAUNCHER_GONE", "The owning launcher is no longer attached.")
  }

  validateInstanceId(instanceId)

  if (!scope || !/^[a-f0-9]{16}$/.test(scope.id) || scope.id !== launch.scope.id) {
    throw new ProtocolError("INVALID_LAUNCHER", "Instance registration scope is invalid.")
  }

  const registrationPath = path.join(launch.directory, `registration-${instanceId}.json`)
  try {
    await readPrivateJson(registrationPath)
    throw new ProtocolError("INVALID_LAUNCHER", "Instance identity is already registered.")
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  await writePrivateJson(registrationPath, {
    version: PROTOCOL_VERSION,
    token: launch.token,
    scope: scope.id,
    instanceId,
    pid: process.pid,
  })
}

export function writeRestartHandoff(
  launch,
  operationId,
  instanceId,
  ctx,
  { restartWrapper = false, nativeTarget } = {}
) {
  if (process.ppid !== launch.pid) {
    throw new ProtocolError("LAUNCHER_GONE", "The owning launcher is no longer attached.")
  }
  if (restartWrapper && launch.canRestartWrapper !== true) {
    throw new ProtocolError(
      "WRAPPER_RESTART_UNAVAILABLE",
      "This launcher does not support wrapper restart."
    )
  }
  const sessionFile = ctx.sessionManager.getSessionFile()
  if (!sessionFile || !path.isAbsolute(sessionFile)) {
    throw new ProtocolError("SESSION_UNAVAILABLE", "The current session cannot be resumed.")
  }
  const handoff = {
    version: PROTOCOL_VERSION,
    token: launch.token,
    operationId,
    instanceId,
    sessionFile,
    cwd: ctx.cwd,
  }
  if (restartWrapper) handoff.restartWrapper = true
  if (nativeTarget) handoff.nativeTarget = nativeTarget
  writeLaunchHandoff(launch, handoff)
}

export function writeLaunchHandoff(launch, handoff) {
  const temporary = `${launch.handoffPath}.${randomBytes(8).toString("hex")}.tmp`
  writeFileSync(temporary, `${JSON.stringify(handoff)}\n`, { mode: 0o600, flag: "wx" })
  renameSync(temporary, launch.handoffPath)
}
