import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { access, link, lstat, open, readFile, readdir, unlink } from "node:fs/promises"
import path from "node:path"

import { listSavedSessions, readRestoreSnapshot } from "./restore.js"
import { prepareLegacyRecoveryExportCommand, prepareSlotRestoreCommand } from "./take-over.js"
import { createTransport, ensurePrivateDirectory } from "./transport.js"

const CHECKPOINT_ID = /^[a-f0-9]{32}$/
const RESTORE_ID = /^[a-f0-9]{32}$/
const BOOT_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const MAX_CHECKPOINT_BYTES = 1024 * 1024

function checkpointDirectory(scope) {
  if (!scope || !/^[a-f0-9]{16}$/.test(scope.id))
    throw new Error("Invalid recovery scope identity.")
  return path.join(scope.agentDir, "instance-control", "restore", "checkpoints")
}

function scopePayload(scope) {
  return {
    id: scope.id,
    configRoot: scope.configRoot,
    profile: scope.profile,
    agentDir: scope.agentDir,
  }
}

async function validateRecordPaths(record) {
  if (!path.isAbsolute(record.cwd))
    throw new Error("Managed session working directory must be absolute.")
  let cwdInfo
  try {
    cwdInfo = await lstat(record.cwd)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (cwdInfo) {
    if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory())
      throw new Error("Managed session working directory is unsafe.")
    await access(record.cwd, constants.R_OK | constants.X_OK)
  }
  if (!record.sessionFile) return
  if (!path.isAbsolute(record.sessionFile))
    throw new Error("Managed session file path must be absolute.")
  let fileInfo
  try {
    fileInfo = await lstat(record.sessionFile)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (!fileInfo) return
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.uid !== process.getuid())
    throw new Error("Managed session file is unsafe.")
  await access(record.sessionFile, constants.R_OK)
}

function normalizedAbsolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value
}

function safeText(value, maximum = 512) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
}

function validateCheckpoint(checkpoint, scope, id) {
  const checkpointScope =
    checkpoint.scope?.id === scope.id &&
    checkpoint.scope?.configRoot === scope.configRoot &&
    checkpoint.scope?.profile === scope.profile &&
    checkpoint.scope?.agentDir === scope.agentDir
  const isLegacy = checkpoint.reason === "legacy"
  const bootValid = isLegacy
    ? checkpoint.bootId === "legacy"
    : BOOT_ID.test(checkpoint.bootId ?? "")
  const timestampValid =
    typeof checkpoint.createdAt === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(checkpoint.createdAt) &&
    !Number.isNaN(Date.parse(checkpoint.createdAt))
  const restoreIds = new Set()
  const entriesValid =
    Array.isArray(checkpoint.entries) &&
    checkpoint.entries.every((entry) => {
      if (
        !RESTORE_ID.test(entry.restoreId ?? "") ||
        restoreIds.has(entry.restoreId) ||
        !safeText(entry.sessionId) ||
        !normalizedAbsolute(entry.cwd)
      )
        return false
      restoreIds.add(entry.restoreId)
      return true
    })
  const sessionsRoot = `${path.join(scope.agentDir, "sessions")}${path.sep}`
  const legacyValid =
    checkpoint.legacy === undefined ||
    (Array.isArray(checkpoint.legacy) &&
      checkpoint.legacy.every(
        (entry) =>
          safeText(entry.cwd) &&
          safeText(entry.sessionId) &&
          (entry.sessionFile === undefined ||
            (normalizedAbsolute(entry.sessionFile) &&
              entry.sessionFile.startsWith(sessionsRoot) &&
              entry.sessionFile.endsWith(".jsonl"))) &&
          (entry.unavailable === undefined || safeText(entry.unavailable))
      ))
  const sourceValid =
    isLegacy &&
    normalizedAbsolute(checkpoint.sourcePath) &&
    /^[a-f0-9]{64}$/.test(checkpoint.sourceSha256 ?? "")
  const warningsValid =
    checkpoint.warnings === undefined ||
    (isLegacy &&
      Array.isArray(checkpoint.warnings) &&
      checkpoint.warnings.every((warning) =>
        /^line \d+: unsupported legacy command format$/.test(warning)
      ))
  if (
    checkpoint.version !== 1 ||
    checkpoint.checkpointId !== id ||
    !checkpointScope ||
    !["automatic", "manual", "legacy"].includes(checkpoint.reason) ||
    !bootValid ||
    !timestampValid ||
    !entriesValid ||
    !legacyValid ||
    (isLegacy && (checkpoint.entries.length !== 0 || !sourceValid)) ||
    (!isLegacy &&
      (checkpoint.legacy !== undefined ||
        checkpoint.sourcePath !== undefined ||
        checkpoint.sourceSha256 !== undefined ||
        checkpoint.warnings !== undefined)) ||
    !warningsValid
  ) {
    throw new Error("Invalid recovery checkpoint.")
  }
}

async function readCheckpoint(file, scope, id) {
  const listed = await lstat(file)
  if (
    listed.isSymbolicLink() ||
    !listed.isFile() ||
    listed.uid !== process.getuid() ||
    (listed.mode & 0o077) !== 0
  )
    throw new Error(`Unsafe private recovery checkpoint: ${file}`)
  if (listed.size > MAX_CHECKPOINT_BYTES)
    throw new Error(`Recovery checkpoint is too large: ${file}`)
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid() ||
      (opened.mode & 0o077) !== 0 ||
      opened.dev !== listed.dev ||
      opened.ino !== listed.ino ||
      opened.size !== listed.size
    )
      throw new Error(`Unsafe private recovery checkpoint changed while being read: ${file}`)
    const bytes = Buffer.alloc(opened.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const final = await handle.stat()
    if (bytesRead !== opened.size || final.size !== opened.size)
      throw new Error(`Recovery checkpoint changed while being read: ${file}`)
    const checkpoint = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))
    validateCheckpoint(checkpoint, scope, id)
    return checkpoint
  } finally {
    await handle.close()
  }
}

export async function listRecoveryCheckpoints(scope) {
  const directory = checkpointDirectory(scope)
  await ensurePrivateDirectory(directory)
  const entries = await readdir(directory, { withFileTypes: true })
  const checkpoints = []
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue
    const id = entry.name.slice(0, -5)
    if (!CHECKPOINT_ID.test(id))
      throw new Error(`Invalid recovery checkpoint filename: ${entry.name}`)
    try {
      checkpoints.push(await readCheckpoint(path.join(directory, entry.name), scope, id))
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return checkpoints.sort(
    (first, second) =>
      Date.parse(second.createdAt) - Date.parse(first.createdAt) ||
      second.checkpointId.localeCompare(first.checkpointId)
  )
}

export async function writeRecoveryCheckpoint(scope, checkpoint) {
  validateCheckpoint(checkpoint, scope, checkpoint.checkpointId)
  const bytes = Buffer.from(JSON.stringify(checkpoint))
  if (bytes.length > MAX_CHECKPOINT_BYTES) throw new Error("Recovery checkpoint is too large.")
  const directory = checkpointDirectory(scope)
  await ensurePrivateDirectory(directory)
  const destination = path.join(directory, `${checkpoint.checkpointId}.json`)
  const temporary = path.join(
    directory,
    `.${checkpoint.checkpointId}.${randomBytes(8).toString("hex")}.tmp`
  )
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await link(temporary, destination)
  } finally {
    await handle.close()
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

export async function captureRecoveryCheckpoint(
  scope,
  { reason = "automatic", excludeRestoreId } = {}
) {
  if (!["automatic", "manual", "legacy"].includes(reason))
    throw new Error("Invalid recovery checkpoint reason.")
  if (excludeRestoreId !== undefined && !RESTORE_ID.test(excludeRestoreId))
    throw new Error("Invalid restore identity.")
  const transport = await createTransport(scope)
  const records = await transport.readRecords()
  const entries = []
  const acceptedRestoreIds = new Set()
  for (const record of records) {
    const restoreId = record.launcherManaged ? record.restoreId : undefined
    if (
      !restoreId ||
      restoreId === excludeRestoreId ||
      !RESTORE_ID.test(restoreId) ||
      acceptedRestoreIds.has(restoreId)
    )
      continue
    await validateRecordPaths(record)
    let snapshot
    try {
      snapshot = await readRestoreSnapshot(scope, restoreId)
    } catch (error) {
      if (error.cause?.code !== "ENOENT") throw error
    }
    if (
      snapshot &&
      snapshot.sessionId === record.sessionId &&
      snapshot.cwd === record.cwd &&
      snapshot.sessionFile === record.sessionFile
    ) {
      acceptedRestoreIds.add(restoreId)
      entries.push({ restoreId, sessionId: snapshot.sessionId, cwd: snapshot.cwd })
    }
  }
  const bootId =
    reason === "legacy"
      ? "legacy"
      : (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
  if (bootId !== "legacy" && !BOOT_ID.test(bootId)) throw new Error("Invalid Linux boot identity.")
  const checkpoint = {
    version: 1,
    checkpointId: randomBytes(16).toString("hex"),
    scope: scopePayload(scope),
    bootId,
    createdAt: new Date().toISOString(),
    reason,
    entries,
  }
  await writeRecoveryCheckpoint(scope, checkpoint)
  if (reason !== "legacy") await pruneRecoveryCheckpoints(scope, checkpoint)
  return checkpoint
}

export async function pruneRecoveryCheckpoints(scope, newest) {
  const checkpoints = await listRecoveryCheckpoints(scope)
  const protectedCheckpoint = checkpoints.find(
    (item) => item.reason !== "legacy" && item.bootId !== newest.bootId
  )
  const retained = new Set([
    newest.checkpointId,
    ...checkpoints
      .filter((checkpoint) => checkpoint.checkpointId !== newest.checkpointId)
      .slice(0, 9)
      .map((checkpoint) => checkpoint.checkpointId),
  ])
  if (protectedCheckpoint) retained.add(protectedCheckpoint.checkpointId)
  const directory = checkpointDirectory(scope)
  for (const checkpoint of checkpoints) {
    if (retained.has(checkpoint.checkpointId)) continue
    try {
      await unlink(path.join(directory, `${checkpoint.checkpointId}.json`))
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

export async function listRecoverySessions(scope, { checkpointId } = {}) {
  let checkpoints = await listRecoveryCheckpoints(scope)
  if (checkpointId !== undefined) {
    if (!CHECKPOINT_ID.test(checkpointId)) throw new Error("Invalid recovery checkpoint identity.")
    checkpoints = checkpoints.filter((checkpoint) => checkpoint.checkpointId === checkpointId)
    if (!checkpoints.length) throw new Error(`Recovery checkpoint not found: ${checkpointId}`)
  }
  const selected = checkpointId
    ? checkpoints
    : checkpoints.filter((item) => item.reason !== "legacy")
  const currentBoot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
  const checkpoint = checkpointId
    ? selected[0]
    : (selected.find((item) => item.bootId !== currentBoot) ?? selected[0])
  const named = await listSavedSessions(scope)
  const namesById = new Map()
  for (const item of named) {
    const id = item.restoreId
    if (id) namesById.set(id, [...(namesById.get(id) ?? []), item.name])
  }
  const defaultMode = checkpointId === undefined
  const membership = checkpoint?.entries ?? []
  const candidates = membership.length
    ? membership
    : checkpoint
      ? []
      : await discoverSnapshots(scope)
  const displayed = defaultMode
    ? [...candidates, ...named.map((item) => ({ restoreId: item.restoreId }))]
    : candidates
  const sessions = []
  const seen = new Set()
  for (const entry of displayed) {
    if (seen.has(entry.restoreId)) continue
    seen.add(entry.restoreId)
    const aliases = namesById.get(entry.restoreId) ?? []
    try {
      const session = await readRestoreSnapshot(scope, entry.restoreId)
      if (session)
        sessions.push({
          restoreId: entry.restoreId,
          ...(aliases[0] ? { name: aliases[0] } : {}),
          session,
        })
      else
        sessions.push({
          restoreId: entry.restoreId,
          ...(aliases[0] ? { name: aliases[0] } : {}),
          unavailable: "No current persisted session snapshot exists.",
        })
    } catch (error) {
      if (error.cause?.code !== "ENOENT") throw error
      sessions.push({
        restoreId: entry.restoreId,
        ...(aliases[0] ? { name: aliases[0] } : {}),
        unavailable: `Current session snapshot is unavailable: ${error.message}`,
      })
    }
  }
  if (checkpoint?.legacy) {
    const { validateLegacyRecoveryEntry } = await import("./legacy-recovery.js")
    for (const legacy of checkpoint.legacy) {
      sessions.push({ legacy: await validateLegacyRecoveryEntry(scope, legacy) })
    }
  }
  return sessions
}

async function discoverSnapshots(scope) {
  const directory = path.join(scope.agentDir, "instance-control", "restore", "snapshots")
  await ensurePrivateDirectory(directory)
  let files
  try {
    files = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const snapshots = []
  for (const entry of files) {
    if (!entry.name.endsWith(".json")) continue
    const restoreId = entry.name.slice(0, -5)
    if (!RESTORE_ID.test(restoreId))
      throw new Error(`Invalid restore snapshot filename: ${entry.name}`)
    if (!entry.isFile()) throw new Error(`Unsafe restore snapshot: ${entry.name}`)
    snapshots.push({ restoreId })
  }
  return snapshots
}

export async function listRecoverySlotIds(scope) {
  const snapshots = await discoverSnapshots(scope)
  return snapshots.map((snapshot) => snapshot.restoreId)
}

export async function exportRecoveryCommands(scope, sessions) {
  const lines = ["# Recovery commands are data for manual review; they are not executed."]
  for (const item of sessions) {
    if (item.legacy) {
      const legacy = item.legacy
      if (legacy.sessionFile) {
        const command = await prepareLegacyRecoveryExportCommand(scope, legacy)
        lines.push(`# Imported legacy session (unowned): ${legacy.sessionId}`, command)
      } else {
        lines.push(`# Unavailable imported legacy session: ${legacy.sessionId}`)
      }
    } else if (item.session && item.restoreId) {
      lines.push(
        await prepareSlotRestoreCommand(scope, item.restoreId, item.session, {
          assertOwnersNotLive: false,
        })
      )
    }
  }
  return `${lines.join("\n")}\n`
}

export async function importLegacyRecovery(scope, source) {
  const { importLegacyRecovery: importLegacy } = await import("./legacy-recovery.js")
  return importLegacy(scope, source)
}
