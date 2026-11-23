import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import path from "node:path"

const MAX_SESSION_HEADER_BYTES = 64 * 1024

function safeText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    // eslint-disable-next-line no-control-regex -- Reject terminal controls in imported metadata.
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
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
    let offset = 0
    for (let recordIndex = 0; recordIndex < 2; recordIndex++) {
      let lineEnd = bytes.indexOf(0x0a, offset)
      if (lineEnd < 0) lineEnd = bytesRead
      if (lineEnd > MAX_SESSION_HEADER_BYTES) return null
      const line = bytes.subarray(offset, lineEnd).toString("utf8")
      let header
      try {
        header = JSON.parse(line)
      } catch {
        return null
      }
      if (header?.type === "session" && safeText(header.id, 512)) return header.id
      if (
        recordIndex !== 0 ||
        header?.type !== "title" ||
        header.v !== 1 ||
        lineEnd - offset + 1 !== 256
      ) {
        return null
      }
      offset = lineEnd + 1
    }
    return null
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
