import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  listRecoveryCheckpoints,
  pruneRecoveryCheckpoints,
  writeRecoveryCheckpoint,
} from "./recovery.js"

const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_SESSION_HEADER_BYTES = 64 * 1024

function safeText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
}

async function validateLegacyDirectory(directory) {
  let info
  try {
    info = await lstat(directory)
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid()) {
    throw new Error(`Unsafe legacy recovery directory: ${directory}`)
  }
  return true
}

function parseQuotedValue(line, start) {
  if (line[start] !== "'") return null
  let value = ""
  let index = start + 1
  while (index < line.length) {
    if (line.startsWith("'\\''", index)) {
      value += "'"
      index += 4
      continue
    }
    if (line[index] === "'") return { value, end: index + 1 }
    value += line[index]
    index += 1
  }
  return null
}

function parseLine(line) {
  const prefix = "cd "
  const separator = " && omp --resume "
  if (!line.startsWith(prefix)) return null
  const cwd = parseQuotedValue(line, prefix.length)
  if (!cwd || !line.startsWith(separator, cwd.end)) return null
  const session = parseQuotedValue(line, cwd.end + separator.length)
  if (!session || session.end !== line.length || !cwd.value || !session.value) return null
  return { cwd: cwd.value, sessionId: session.value }
}

async function readSessionHeader(file) {
  const listed = await lstat(file)
  if (listed.isSymbolicLink() || !listed.isFile() || listed.uid !== process.getuid()) {
    throw new Error(`Unsafe OMP session transcript: ${file}`)
  }
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK
  )
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid() ||
      opened.dev !== listed.dev ||
      opened.ino !== listed.ino
    ) {
      throw new Error(`OMP session transcript changed while being read: ${file}`)
    }
    const bytes = Buffer.alloc(MAX_SESSION_HEADER_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    let lineEnd = bytes.indexOf(0x0a, 0)
    if (lineEnd < 0) lineEnd = bytesRead
    if (lineEnd > MAX_SESSION_HEADER_BYTES) return null
    const line = bytes.subarray(0, lineEnd).toString("utf8")
    let header
    try {
      header = JSON.parse(line)
    } catch {
      return null
    }
    return header?.type === "session" && safeText(header.id, 512) ? header.id : null
  } finally {
    await handle.close()
  }
}

export async function validateLegacyRecoveryEntry(scope, entry) {
  if (!path.isAbsolute(entry.cwd))
    return { ...entry, unavailable: "Legacy working directory is not absolute." }
  let cwdInfo
  try {
    cwdInfo = await lstat(entry.cwd)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (
    cwdInfo &&
    (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory() || cwdInfo.uid !== process.getuid())
  ) {
    throw new Error(`Unsafe legacy working directory: ${entry.cwd}`)
  }
  if (!entry.sessionFile) {
    return cwdInfo ? entry : { ...entry, unavailable: "Legacy working directory is unavailable." }
  }
  const sessionsRoot = path.resolve(scope.agentDir, "sessions")
  const relative = path.relative(sessionsRoot, entry.sessionFile)
  if (
    !path.isAbsolute(entry.sessionFile) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !entry.sessionFile.endsWith(".jsonl")
  ) {
    throw new Error("Legacy transcript path is outside the scoped session tree.")
  }
  let current = sessionsRoot
  let rootInfo
  try {
    rootInfo = await lstat(sessionsRoot)
  } catch (error) {
    if (error.code === "ENOENT")
      return { ...entry, sessionFile: undefined, unavailable: "Legacy transcript is unavailable." }
    throw error
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.uid !== process.getuid()) {
    throw new Error(`Unsafe legacy session tree: ${sessionsRoot}`)
  }
  for (const component of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, component)
    let directoryInfo
    try {
      directoryInfo = await lstat(current)
    } catch (error) {
      if (error.code === "ENOENT")
        return {
          ...entry,
          sessionFile: undefined,
          unavailable: "Legacy transcript is unavailable.",
        }
      throw error
    }
    if (
      directoryInfo.isSymbolicLink() ||
      !directoryInfo.isDirectory() ||
      directoryInfo.uid !== process.getuid()
    ) {
      throw new Error(`Unsafe legacy transcript directory: ${current}`)
    }
  }
  let sessionId
  try {
    sessionId = await readSessionHeader(entry.sessionFile)
  } catch (error) {
    if (error.code === "ENOENT")
      return { ...entry, sessionFile: undefined, unavailable: "Legacy transcript is unavailable." }
    throw error
  }
  if (!sessionId) throw new Error(`Legacy transcript header is invalid: ${entry.sessionFile}`)
  if (sessionId !== entry.sessionId)
    throw new Error(`Legacy transcript ID changed: ${entry.sessionFile}`)
  return cwdInfo
    ? entry
    : { ...entry, sessionFile: undefined, unavailable: "Legacy working directory is unavailable." }
}

async function collectSessionFiles(directory, files) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    const info = await lstat(file)
    if (info.isSymbolicLink() || info.uid !== process.getuid())
      throw new Error(`Unsafe path in OMP session tree: ${file}`)
    if (info.isDirectory()) await collectSessionFiles(file, files)
    else if (entry.name.endsWith(".jsonl")) {
      if (!info.isFile()) throw new Error(`OMP session transcript is not a regular file: ${file}`)
      files.push(file)
    }
  }
}

async function legacyEntry(cwd, sessionId, sessionsById) {
  if (!path.isAbsolute(cwd))
    return { cwd, sessionId, unavailable: "Legacy working directory is not absolute." }
  const matches = sessionsById.get(sessionId) ?? []
  if (matches.length !== 1) {
    return {
      cwd,
      sessionId,
      unavailable: matches.length
        ? "Legacy session ID is ambiguous within this profile."
        : "Legacy session ID is missing within this profile.",
    }
  }
  return { cwd, sessionId, sessionFile: matches[0] }
}

async function indexSessions(scope) {
  const root = path.join(scope.agentDir, "sessions")
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (error.code === "ENOENT") return new Map()
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid()) {
    throw new Error(`Unsafe OMP session tree: ${root}`)
  }
  const files = []
  await collectSessionFiles(root, files)
  const sessions = new Map()
  for (const file of files) {
    const sessionId = await readSessionHeader(file)
    if (!sessionId) continue
    const absolutePath = path.resolve(file)
    sessions.set(sessionId, [...(sessions.get(sessionId) ?? []), absolutePath])
  }
  return sessions
}

async function readLegacySource(file) {
  const absolutePath = path.resolve(file)
  if ((await realpath(absolutePath)) !== absolutePath) {
    throw new Error(`Legacy recovery source traverses a symbolic link: ${absolutePath}`)
  }
  const listed = await lstat(absolutePath)
  if (
    listed.isSymbolicLink() ||
    !listed.isFile() ||
    listed.uid !== process.getuid() ||
    listed.size > MAX_SOURCE_BYTES
  ) {
    throw new Error(`Unsafe legacy recovery source: ${absolutePath}`)
  }
  const handle = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK
  )
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid() ||
      opened.dev !== listed.dev ||
      opened.ino !== listed.ino ||
      opened.size !== listed.size
    ) {
      throw new Error(`Legacy recovery source changed while being read: ${absolutePath}`)
    }
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== opened.size)
      throw new Error(`Legacy recovery source changed while being read: ${file}`)
    return bytes.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function importLegacyRecovery(scope, source) {
  const defaultRoot = path.join(os.homedir(), ".local/state/omp-session-resume-helper")
  let files
  if (source) {
    files = [path.resolve(source)]
  } else {
    const rootExists = await validateLegacyDirectory(defaultRoot)
    if (!rootExists) {
      files = []
    } else {
      const snapshotDirectory = path.join(defaultRoot, "snapshots")
      const snapshotsExist = await validateLegacyDirectory(snapshotDirectory)
      let names = []
      if (snapshotsExist) names = await readdir(snapshotDirectory, { withFileTypes: true })
      files = names
        .filter((entry) => entry.name.endsWith(".txt"))
        .map((entry) => path.join(snapshotDirectory, entry.name))
      const activeSessions = path.join(defaultRoot, "active-sessions.txt")
      try {
        await lstat(activeSessions)
        files.push(activeSessions)
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }

  const checkpoints = await listRecoveryCheckpoints(scope)
  const sessionsById = await indexSessions(scope)
  const imported = []
  for (const file of files) {
    let bytes
    try {
      bytes = await readLegacySource(file)
    } catch (error) {
      if (!source && error.code === "ENOENT") continue
      throw error
    }
    const sourcePath = path.resolve(file)
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex")
    const identity = createHash("sha256")
      .update(sourcePath)
      .update("\0")
      .update(bytes)
      .digest("hex")
      .slice(0, 32)
    const prior = checkpoints.find(
      (item) => item.reason === "legacy" && item.checkpointId === identity
    )
    if (prior) {
      imported.push(prior)
      continue
    }
    const legacy = []
    const warnings = []
    for (const [index, line] of bytes.toString("utf8").split(/\r?\n/u).entries()) {
      if (!line) continue
      const parsed = parseLine(line)
      if (!parsed || !safeText(parsed.cwd, 4096) || !safeText(parsed.sessionId, 512)) {
        warnings.push(`line ${index + 1}: unsupported legacy command format`)
        continue
      }
      legacy.push(await legacyEntry(parsed.cwd, parsed.sessionId, sessionsById))
    }
    const checkpoint = {
      version: 1,
      checkpointId: identity,
      scope: {
        id: scope.id,
        configRoot: scope.configRoot,
        profile: scope.profile,
        agentDir: scope.agentDir,
      },
      bootId: "legacy",
      createdAt: new Date().toISOString(),
      reason: "legacy",
      entries: [],
      legacy,
      sourcePath,
      sourceSha256,
      ...(warnings.length ? { warnings } : {}),
    }
    try {
      await writeRecoveryCheckpoint(scope, checkpoint)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const existing = (await listRecoveryCheckpoints(scope)).find(
        (item) => item.checkpointId === identity
      )
      if (!existing || existing.sourcePath !== sourcePath || existing.sourceSha256 !== sourceSha256)
        throw error
      imported.push(existing)
      continue
    }
    await pruneRecoveryCheckpoints(scope, checkpoint)
    imported.push(checkpoint)
  }
  const retained = new Set(
    (await listRecoveryCheckpoints(scope)).map((checkpoint) => checkpoint.checkpointId)
  )
  return imported.filter((checkpoint) => retained.has(checkpoint.checkpointId))
}
