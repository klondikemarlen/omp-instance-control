import { constants } from "node:fs"
import { randomBytes } from "node:crypto"
import { access, link, lstat, open, readFile, readdir, unlink } from "node:fs/promises"
import path from "node:path"

import { ensurePrivateDirectory, writePrivateJson } from "./transport.js"

const RESTORE_ID = /^[a-f0-9]{32}$/
const RESTORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BOOT_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const MAX_JSON_BYTES = 1024 * 1024
const MAX_RESUME_ARGS = 256
const MAX_RESUME_ARG_BYTES = 64 * 1024
const NUL_CHARACTER = /\u0000/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
let cachedBootId
let cachedAgentOwner

function currentUid() {
  return process.getuid()
}

function restoreDirectory(scope) {
  if (!scope || !/^[a-f0-9]{16}$/.test(scope.id)) {
    throw new Error("Invalid restore scope identity.")
  }
  return path.join(scope.agentDir, "instance-control", "restore")
}

function validateScope(snapshotScope, scope) {
  if (
    !snapshotScope ||
    snapshotScope.id !== scope.id ||
    snapshotScope.configRoot !== scope.configRoot ||
    snapshotScope.profile !== scope.profile ||
    snapshotScope.agentDir !== scope.agentDir
  ) {
    throw new Error("Saved session belongs to a different OMP scope.")
  }
}

function validateOwner(owner) {
  if (
    !owner ||
    typeof owner !== "object" ||
    !BOOT_ID.test(owner.bootId ?? "") ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.startTime !== "string" ||
    !/^\d+$/.test(owner.startTime)
  ) {
    throw new Error("Saved session process ownership is invalid.")
  }
}

async function readBootId() {
  if (!cachedBootId) {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
    if (!BOOT_ID.test(bootId)) {
      throw new Error("Unable to verify the current Linux boot identity.")
    }
    cachedBootId = bootId
  }
  return cachedBootId
}

export async function getCurrentAgentOwner() {
  if (cachedAgentOwner) return { ...cachedAgentOwner }
  const bootId = await readBootId()
  const startTime = await readProcessStartTime(process.pid, "OMP agent")
  if (!startTime) {
    throw new Error("Unable to verify the current OMP agent process start time.")
  }
  cachedAgentOwner = { bootId, pid: process.pid, startTime }
  return { ...cachedAgentOwner }
}

function validateResumeArgs(resumeArgs) {
  if (
    !Array.isArray(resumeArgs) ||
    resumeArgs.length > MAX_RESUME_ARGS ||
    resumeArgs.some(
      (argument) =>
        typeof argument !== "string" ||
        NUL_CHARACTER.test(argument) ||
        Buffer.byteLength(argument, "utf8") > MAX_RESUME_ARG_BYTES
    )
  ) {
    throw new Error("Saved session resume arguments are missing or unsafe.")
  }
  const totalBytes = resumeArgs.reduce((total, argument) => total + Buffer.byteLength(argument), 0)
  if (totalBytes > MAX_JSON_BYTES / 2) {
    throw new Error("Saved session resume arguments are too large.")
  }
}

function validateSnapshot(snapshot, scope, expectedRestoreId) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Saved session snapshot is not an object.")
  }
  if (snapshot.version !== 1 || !RESTORE_ID.test(snapshot.restoreId ?? "")) {
    throw new Error("Saved session snapshot identity is invalid.")
  }
  if (expectedRestoreId && snapshot.restoreId !== expectedRestoreId) {
    throw new Error("Saved session filename does not match its restore identity.")
  }
  validateScope(snapshot.scope, scope)
  if (
    typeof snapshot.sessionId !== "string" ||
    snapshot.sessionId.length === 0 ||
    snapshot.sessionId.length > 4096 ||
    CONTROL_CHARACTERS.test(snapshot.sessionId)
  ) {
    throw new Error("Saved session has no safe persisted session identity.")
  }
  if (
    typeof snapshot.sessionFile !== "string" ||
    !path.isAbsolute(snapshot.sessionFile) ||
    CONTROL_CHARACTERS.test(snapshot.sessionFile)
  ) {
    throw new Error("Saved session file path is missing or unsafe.")
  }
  if (
    typeof snapshot.cwd !== "string" ||
    !path.isAbsolute(snapshot.cwd) ||
    CONTROL_CHARACTERS.test(snapshot.cwd)
  ) {
    throw new Error("Saved session working directory is missing or unsafe.")
  }
  validateResumeArgs(snapshot.resumeArgs)
  validateOwner(snapshot.owner)
  validateOwner(snapshot.agentOwner)
  if (
    typeof snapshot.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.updatedAt)) ||
    new Date(snapshot.updatedAt).toISOString() !== snapshot.updatedAt
  ) {
    throw new Error("Saved session update time is invalid.")
  }
  return snapshot
}

async function assertPrivateJsonFile(file, maxBytes = MAX_JSON_BYTES) {
  let listedInfo
  try {
    listedInfo = await lstat(file)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  if (
    listedInfo.isSymbolicLink() ||
    !listedInfo.isFile() ||
    listedInfo.uid !== currentUid() ||
    (listedInfo.mode & 0o077) !== 0
  ) {
    throw new Error(`Unsafe private restore file: ${file}`)
  }
  if (listedInfo.size > maxBytes) {
    throw new Error(`Private restore file is too large: ${file}`)
  }
  return listedInfo
}

async function readBoundedPrivateJson(file, expectedSize = MAX_JSON_BYTES) {
  const listedInfo = await assertPrivateJsonFile(file, expectedSize)
  if (!listedInfo) return null

  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedInfo = await handle.stat()
    if (
      !openedInfo.isFile() ||
      openedInfo.uid !== currentUid() ||
      (openedInfo.mode & 0o077) !== 0 ||
      openedInfo.dev !== listedInfo.dev ||
      openedInfo.ino !== listedInfo.ino ||
      openedInfo.size !== listedInfo.size
    ) {
      throw new Error(`Unsafe private restore file changed while being read: ${file}`)
    }
    const bytes = Buffer.alloc(openedInfo.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const finalInfo = await handle.stat()
    if (bytesRead !== openedInfo.size || finalInfo.size !== openedInfo.size) {
      throw new Error(`Private restore file changed while being read: ${file}`)
    }
    try {
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))
    } catch (error) {
      throw new Error(`Invalid private restore JSON in ${file}: ${error.message}`)
    }
  } finally {
    await handle.close()
  }
}

async function assertUsableSessionPaths(snapshot) {
  let cwdInfo
  try {
    cwdInfo = await lstat(snapshot.cwd)
  } catch (error) {
    throw new Error(`Saved session working directory is unavailable: ${error.message}`)
  }
  if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory()) {
    throw new Error("Saved session working directory is not a real directory.")
  }
  await access(snapshot.cwd, constants.R_OK | constants.X_OK)
  let sessionInfo
  try {
    sessionInfo = await lstat(snapshot.sessionFile)
  } catch (error) {
    throw new Error(`Saved session file is unavailable: ${error.message}`)
  }
  if (
    sessionInfo.isSymbolicLink() ||
    !sessionInfo.isFile() ||
    sessionInfo.uid !== currentUid() ||
    sessionInfo.size === 0
  ) {
    throw new Error("Saved session file is unsafe, empty, or not a readable regular file.")
  }
  await access(snapshot.sessionFile, constants.R_OK)
}

function snapshotPaths(scope, restoreId) {
  if (!RESTORE_ID.test(restoreId ?? "")) {
    throw new Error("Invalid restore identity.")
  }
  const snapshots = path.join(restoreDirectory(scope), "snapshots")
  return { snapshots, file: path.join(snapshots, `${restoreId}.json`) }
}

function namesDirectory(scope) {
  return path.join(restoreDirectory(scope), "names")
}

export function validateRestoreName(name) {
  if (typeof name !== "string" || !RESTORE_NAME.test(name) || name === "save") {
    throw new Error("Restore names must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}; 'save' is reserved.")
  }
  return name
}

export async function writeRestoreSnapshot(scope, snapshot) {
  validateSnapshot(snapshot, scope)
  await assertUsableSessionPaths(snapshot)
  const { snapshots, file } = snapshotPaths(scope, snapshot.restoreId)
  await ensurePrivateDirectory(snapshots)
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8")
  if (bytes > MAX_JSON_BYTES) {
    throw new Error("Saved session snapshot is too large.")
  }
  await writePrivateJson(file, snapshot)
  return snapshot
}

export async function readRestoreSnapshot(scope, restoreId, { validatePaths = true } = {}) {
  const { snapshots, file } = snapshotPaths(scope, restoreId)
  await ensurePrivateDirectory(snapshots)
  const snapshot = await readBoundedPrivateJson(file)
  if (!snapshot) return null
  validateSnapshot(snapshot, scope, restoreId)
  if (validatePaths) await assertUsableSessionPaths(snapshot)
  return snapshot
}

export async function invalidateRestoreSnapshot(scope, restoreId) {
  const { snapshots, file } = snapshotPaths(scope, restoreId)
  await ensurePrivateDirectory(snapshots)
  const listedInfo = await assertPrivateJsonFile(file, Number.MAX_SAFE_INTEGER)
  if (!listedInfo) return false

  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedInfo = await handle.stat()
    const currentInfo = await lstat(file)
    if (
      !openedInfo.isFile() ||
      openedInfo.uid !== currentUid() ||
      (openedInfo.mode & 0o077) !== 0 ||
      openedInfo.dev !== listedInfo.dev ||
      openedInfo.ino !== listedInfo.ino ||
      currentInfo.isSymbolicLink() ||
      !currentInfo.isFile() ||
      currentInfo.dev !== openedInfo.dev ||
      currentInfo.ino !== openedInfo.ino
    ) {
      throw new Error(`Unsafe private restore snapshot changed before invalidation: ${file}`)
    }
    await unlink(file)
    return true
  } finally {
    await handle.close()
  }
}

async function invalidateFailedCapture(scope, restoreId, captureError) {
  try {
    await invalidateRestoreSnapshot(scope, restoreId)
  } catch (invalidationError) {
    throw new Error(
      `${captureError.message}; previous restore snapshot could not be safely invalidated: ${invalidationError.message}`,
      { cause: captureError }
    )
  }
  throw captureError
}

export async function captureRestoreSnapshot(scope, launch, ctx) {
  if (!launch?.restoreId) return false
  if (launch.restartError) {
    await invalidateRestoreSnapshot(scope, launch.restoreId)
    return false
  }

  let sessionFile
  let sessionId
  try {
    sessionFile = ctx.sessionManager?.getSessionFile()
    sessionId = ctx.sessionManager?.getSessionId()
  } catch (error) {
    return invalidateFailedCapture(scope, launch.restoreId, error)
  }
  if (!sessionFile || !sessionId) {
    await invalidateRestoreSnapshot(scope, launch.restoreId)
    return false
  }

  try {
    const agentOwner = await getCurrentAgentOwner()
    const snapshot = {
      version: 1,
      restoreId: launch.restoreId,
      scope: {
        id: scope.id,
        configRoot: scope.configRoot,
        profile: scope.profile,
        agentDir: scope.agentDir,
      },
      sessionFile,
      agentOwner,
      sessionId,
      cwd: ctx.cwd,
      resumeArgs: launch.resumeArgs,
      owner: launch.owner,
      updatedAt: new Date().toISOString(),
    }
    await writeRestoreSnapshot(scope, snapshot)
    return true
  } catch (error) {
    return invalidateFailedCapture(scope, launch.restoreId, error)
  }
}

export async function saveRestoreName(scope, name, restoreId, { expectedSnapshot } = {}) {
  validateRestoreName(name)
  const snapshot = await readRestoreSnapshot(scope, restoreId)
  if (!snapshot) {
    throw new Error("The managed instance has no persisted restore snapshot.")
  }
  if (expectedSnapshot && JSON.stringify(snapshot) !== JSON.stringify(expectedSnapshot)) {
    throw new Error("The managed session changed while its restore name was being saved.")
  }
  const directory = namesDirectory(scope)
  await ensurePrivateDirectory(directory)
  const file = path.join(directory, `${name}.json`)
  const temporary = path.join(
    directory,
    `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  )
  const payload = { version: 1, restoreId }
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await link(temporary, file)
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Restore name '${name}' already exists and cannot be overwritten.`)
    }
    throw error
  } finally {
    if (handle) await handle.close()
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }
  return { name, session: snapshot }
}

export async function listSavedSessions(scope) {
  const directory = namesDirectory(scope)
  await ensurePrivateDirectory(directory)
  const entries = await readdir(directory, { withFileTypes: true })
  const saved = []
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue
    const name = entry.name.slice(0, -5)
    validateRestoreName(name)
    if (!entry.isFile()) {
      throw new Error(`Unsafe saved restore name: ${entry.name}`)
    }
    const file = path.join(directory, entry.name)
    const payload = await readBoundedPrivateJson(file, 4096)
    if (!payload || payload.version !== 1 || !RESTORE_ID.test(payload.restoreId ?? "")) {
      throw new Error(`Invalid saved restore name binding: ${entry.name}`)
    }
    let session
    let unavailable
    try {
      session = await readRestoreSnapshot(scope, payload.restoreId)
    } catch (error) {
      unavailable = `Current session snapshot is unavailable: ${error.message}`
    }
    if (session) {
      saved.push({ name, session })
    } else {
      saved.push({
        name,
        unavailable:
          unavailable ??
          "No current persisted session snapshot exists; persist this session and wait for its next lifecycle update.",
      })
    }
  }
  return saved.sort((first, second) => first.name.localeCompare(second.name))
}

async function readProcessStartTime(pid, role) {
  let contents
  try {
    contents = await readFile(`/proc/${pid}/stat`, "utf8")
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null
    throw new Error(`Unable to verify saved session ${role} process: ${error.message}`)
  }
  const closingParenthesis = contents.lastIndexOf(")")
  if (closingParenthesis < 0) {
    throw new Error(`Unable to verify saved session ${role} process metadata.`)
  }
  const fields = contents
    .slice(closingParenthesis + 1)
    .trim()
    .split(/\s+/)
  const startTime = fields[19]
  if (!/^\d+$/.test(startTime ?? "")) {
    throw new Error(`Unable to verify saved session ${role} start time.`)
  }
  return startTime
}

async function assertOwnerNotLive(owner, role) {
  validateOwner(owner)
  let bootId
  try {
    bootId = await readBootId()
  } catch (error) {
    throw new Error(`Unable to verify saved session ${role} boot identity: ${error.message}`)
  }
  if (owner.bootId !== bootId) return

  const startTime = await readProcessStartTime(owner.pid, role)
  if (startTime === null) return
  if (startTime === owner.startTime) {
    throw new Error(`The ${role} that owns this saved session is still running.`)
  }
}

export async function assertRestoreOwnersNotLive(owner, agentOwner) {
  await assertOwnerNotLive(owner, "launcher")
  await assertOwnerNotLive(agentOwner, "OMP agent")
}
