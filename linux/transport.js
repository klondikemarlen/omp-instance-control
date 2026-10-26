import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { ProtocolError, validateRequest, validateResponse } from "../protocol/index.js"

function scopeDirectoryName(scopeId) {
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    throw new Error("Invalid transport scope identity")
  }
  return createHash("sha256").update(scopeId).digest("hex").slice(0, 16)
}

const MAX_FRAME_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 5_000
const INSTANCE_ID = /^[a-f0-9]{32}$/
const SEND_CONTEXT_STATE_DIRECTORY = [".omp", "agent", "editor-context-bridge.json.d"]
const SEND_CONTEXT_HEALTH_TIMEOUT_MS = 500
const MAX_HEALTH_RESPONSE_BYTES = 4096

// Return loaded metadata only after the private record and live health identity agree.
export async function readSendContextMetadata(instanceRecord) {
  if (
    !instanceRecord ||
    !INSTANCE_ID.test(instanceRecord.instanceId ?? "") ||
    !Number.isSafeInteger(instanceRecord.pid) ||
    instanceRecord.pid <= 0
  ) {
    return null
  }

  let directory
  try {
    directory = path.join(os.homedir(), ...SEND_CONTEXT_STATE_DIRECTORY)
    await assertExistingPrivateDirectory(directory)
  } catch {
    return null
  }

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }

  let matchingState
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue
    const instanceId = entry.name.slice(0, -".json".length)
    if (!INSTANCE_ID.test(instanceId)) continue
    if (!entry.isFile()) return null

    let state
    try {
      state = await readPrivateJson(path.join(directory, entry.name))
    } catch {
      return null
    }
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      state.instanceId !== instanceId ||
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 0
    ) {
      return null
    }
    if (state.pid !== instanceRecord.pid) continue
    if (typeof state.endpoint !== "string") return null
    if (matchingState !== undefined) return null
    matchingState = { endpoint: state.endpoint, instanceId: state.instanceId, pid: state.pid }
  }

  if (matchingState === undefined) return null
  return verifySendContextHealth(matchingState)
}

async function assertExistingPrivateDirectory(directory) {
  const absolute = path.resolve(directory)
  const components = absolute.split(path.sep).filter(Boolean)
  let current = path.parse(absolute).root
  for (const component of components) {
    current = path.join(current, component)
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe private directory: ${current}`)
    }
    if (current === absolute) {
      if (info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
        throw new Error(`Unsafe private directory: ${current}`)
      }
      continue
    }
    const trustedOwner = info.uid === 0 || info.uid === currentUid()
    const stickyTmp = current === "/tmp" && info.uid === 0 && (info.mode & 0o1000) !== 0
    if (!trustedOwner || ((info.mode & 0o022) !== 0 && !stickyTmp)) {
      throw new Error(`Unsafe private directory ancestor: ${current}`)
    }
  }
}

async function verifySendContextHealth(state) {
  let endpoint
  try {
    endpoint = new URL(state.endpoint)
  } catch {
    return null
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !/^[1-9]\d{0,4}$/.test(endpoint.port) ||
    Number(endpoint.port) > 65535 ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    return null
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEND_CONTEXT_HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(`${endpoint.origin}/health`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.body !== null) await response.body.cancel().catch(() => {})
      return null
    }
    const health = await readBoundedJson(response)
    if (
      health?.ok !== true ||
      health.instanceId !== state.instanceId ||
      health.pid !== state.pid ||
      typeof health.version !== "string" ||
      health.version.trim() === "" ||
      health.version !== health.version.trim() ||
      health.version.toLowerCase() === "unknown" ||
      health.version.length > 128 ||
      !Number.isSafeInteger(health.protocolVersion) ||
      health.protocolVersion <= 0
    ) {
      return null
    }
    return { version: health.version, protocolVersion: health.protocolVersion }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function readBoundedJson(response) {
  if (response.body === null) return null
  const contentLength = response.headers.get("content-length")
  if (/^\d+$/.test(contentLength ?? "") && Number(contentLength) > MAX_HEALTH_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => {})
    return null
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_HEALTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    reader.releaseLock()
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid
}

export function getRuntimeRoot(env = process.env) {
  if (process.platform !== "linux") {
    throw new Error(`Linux transport is unsupported on ${process.platform}`)
  }

  const uid = currentUid()
  const runtimeDirectory = env.XDG_RUNTIME_DIR
  if (runtimeDirectory) {
    if (!path.isAbsolute(runtimeDirectory)) {
      throw new Error("XDG_RUNTIME_DIR must be an absolute path")
    }
    return path.join(runtimeDirectory, "omp-instance-control")
  }
  return path.join("/tmp", `omp-instance-control-${uid}`)
}

async function inspectDirectory(directory, { privateLeaf = false } = {}) {
  let info
  try {
    info = await lstat(directory)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (creationError) {
      if (creationError.code !== "EEXIST") throw creationError
    }
    info = await lstat(directory)
  }

  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe runtime directory: ${directory} is not a real directory`)
  }
  if (privateLeaf) {
    if (info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
      throw new Error(
        `Unsafe runtime directory: ${directory} is foreign-owned or accessible by other users`
      )
    }
    return
  }
  const trustedOwner = info.uid === 0 || info.uid === currentUid()
  const stickyTmp = directory === "/tmp" && info.uid === 0 && (info.mode & 0o1000) !== 0
  if (!trustedOwner || ((info.mode & 0o022) !== 0 && !stickyTmp)) {
    throw new Error(`Unsafe runtime directory ancestor: ${directory}`)
  }
}

export async function ensurePrivateDirectory(directory) {
  const absolute = path.resolve(directory)
  const components = absolute.split(path.sep).filter(Boolean)
  let current = path.parse(absolute).root
  for (const component of components) {
    current = path.join(current, component)
    await inspectDirectory(current, { privateLeaf: current === absolute })
  }
}

async function assertPrivateFile(file) {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Unsafe private file: ${file} is not a regular file`)
  }
  if (info.uid !== currentUid()) {
    throw new Error(`Unsafe private file: ${file} is not owned by the current user`)
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Unsafe private file: ${file} is accessible by other users`)
  }
  return info
}

export async function writePrivateJson(file, value) {
  await ensurePrivateDirectory(path.dirname(file))
  await assertPrivateFile(file)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = null
    await assertPrivateFile(file)
    await rename(temporary, file)
  } finally {
    if (handle) await handle.close()
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

export async function readPrivateJson(file) {
  await assertPrivateFile(file)
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
      throw new Error(`Unsafe private file: ${file}`)
    }
    return JSON.parse(await handle.readFile("utf8"))
  } finally {
    await handle.close()
  }
}

function validateRecord(record, scope) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid instance record: expected an object")
  }
  if (
    record.version !== 1 ||
    !INSTANCE_ID.test(record.instanceId ?? "") ||
    record.scope !== scope.id
  ) {
    throw new Error("Invalid instance record identity or scope")
  }
  if (
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.cwd !== "string" ||
    typeof record.sessionId !== "string" ||
    !(record.sessionFile === null || typeof record.sessionFile === "string") ||
    typeof record.launcherManaged !== "boolean" ||
    typeof record.state !== "string" ||
    !(
      record.lastRestart === null ||
      (typeof record.lastRestart === "object" && !Array.isArray(record.lastRestart))
    )
  ) {
    throw new Error(`Invalid instance record fields: ${record.instanceId}`)
  }
  return record
}

function recordPath(directory, instanceId) {
  if (!INSTANCE_ID.test(instanceId ?? "")) throw new Error("Invalid instance identity")
  return path.join(directory, `${instanceId}.json`)
}

function socketPath(directory, instanceId) {
  if (!INSTANCE_ID.test(instanceId ?? "")) throw new Error("Invalid instance identity")
  const result = path.join(directory, `${instanceId}.sock`)
  if (Buffer.byteLength(result) >= 108) {
    throw new Error(`Unix socket path is too long (${Buffer.byteLength(result)} bytes): ${result}`)
  }
  return result
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino
}

function sameSocketIdentity(first, second) {
  return (
    first.exists === second.exists &&
    (!first.exists ||
      (first.dev === second.dev &&
        first.ino === second.ino &&
        first.uid === second.uid &&
        first.mode === second.mode))
  )
}

function inspectSocketInfo(info, file) {
  if (info.isSymbolicLink() || !info.isSocket()) {
    throw new Error(`Unsafe endpoint: ${file} is not a Unix socket`)
  }
  if (info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
    throw new Error(`Unsafe endpoint: ${file} is foreign-owned or accessible by other users`)
  }
  return {
    exists: true,
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
  }
}

async function inspectSocket(file) {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false }
    }
    throw error
  }
  return inspectSocketInfo(info, file)
}

function probeEndpoint(file) {
  const { promise, resolve } = Promise.withResolvers()
  const socket = net.createConnection(file)
  let settled = false
  const finish = (result) => {
    if (settled) {
      return
    }

    settled = true
    clearTimeout(timer)
    socket.destroy()
    resolve(result)
  }
  const timer = setTimeout(
    () =>
      finish({
        error: Object.assign(new Error("Endpoint connection timed out"), {
          code: "ETIMEDOUT",
        }),
      }),
    REQUEST_TIMEOUT_MS
  )
  socket.once("connect", () => finish({ connected: true }))
  socket.once("error", (error) => finish({ error }))
  return promise
}

function ownerIsAbsent(pid) {
  try {
    process.kill(pid, 0)
    return { absent: false, reason: "recorded process is still present" }
  } catch (error) {
    if (error.code === "ESRCH") {
      return { absent: true }
    }
    if (error.code === "EPERM") {
      return { absent: false, reason: "permission denied while checking the recorded process" }
    }
    return {
      absent: false,
      reason: `could not verify the recorded process: ${error.message}`,
    }
  }
}

function connectionFailureReason(error) {
  if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
    return undefined
  }
  return `endpoint could not be checked safely: ${error.message}`
}

function encodeFrame(value) {
  const frame = Buffer.from(`${JSON.stringify(value)}\n`)
  if (frame.byteLength > MAX_FRAME_BYTES) throw new Error("IPC frame exceeds the maximum size")
  return frame
}

function sendError(error, request) {
  const protocolError =
    error instanceof ProtocolError
      ? error
      : new ProtocolError("INTERNAL", error.message ?? "Request failed")
  return {
    version: 1,
    instanceId: request.instanceId,
    requestId: request.requestId,
    ok: false,
    error: { code: protocolError.code, message: protocolError.message },
  }
}

export async function createTransport(scope, { env = process.env } = {}) {
  const runtimeRoot = getRuntimeRoot(env)
  await ensurePrivateDirectory(runtimeRoot)
  const directory = path.join(runtimeRoot, scopeDirectoryName(scope?.id))
  await ensurePrivateDirectory(directory)

  async function readRecords() {
    const entries = await readdir(directory, { withFileTypes: true })
    const records = []
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue
      const instanceId = entry.name.slice(0, -5)
      if (!INSTANCE_ID.test(instanceId))
        throw new Error(`Invalid instance record filename: ${entry.name}`)
      let value
      try {
        value = await readPrivateJson(path.join(directory, entry.name))
      } catch (error) {
        if (error.code === "ENOENT") continue
        throw error
      }
      const record = validateRecord(value, scope)
      if (record.instanceId !== instanceId)
        throw new Error(`Instance record filename does not match identity: ${entry.name}`)
      records.push(record)
    }
    return records
  }

  async function readCleanupSnapshot(instanceId) {
    const file = recordPath(directory, instanceId)
    const listedInfo = await assertPrivateFile(file)
    if (!listedInfo) {
      return null
    }

    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const openedInfo = await handle.stat()
      if (
        !openedInfo.isFile() ||
        openedInfo.uid !== currentUid() ||
        (openedInfo.mode & 0o077) !== 0 ||
        !sameFileIdentity(listedInfo, openedInfo)
      ) {
        throw new Error(`Unsafe private file: ${file} changed while it was being read`)
      }
      const bytes = await handle.readFile()
      const record = validateRecord(JSON.parse(bytes.toString("utf8")), scope)
      if (record.instanceId !== instanceId) {
        throw new Error(`Instance record filename does not match identity: ${instanceId}.json`)
      }
      return { file, record, bytes, info: openedInfo }
    } finally {
      await handle.close()
    }
  }

  async function cleanupOneRecord(instanceId) {
    const result = (status, reason) => ({ instanceId, status, reason })
    let snapshot
    try {
      snapshot = await readCleanupSnapshot(instanceId)
    } catch (error) {
      return result("failed", `record is invalid or unsafe: ${error.message}`)
    }
    if (!snapshot) {
      return result("preserved", "record disappeared before it could be checked")
    }

    const owner = ownerIsAbsent(snapshot.record.pid)
    if (!owner.absent) {
      return result("preserved", owner.reason)
    }

    const endpoint = socketPath(directory, instanceId)
    let originalSocket
    try {
      originalSocket = await inspectSocket(endpoint)
    } catch (error) {
      return result("failed", `endpoint is unsafe: ${error.message}`)
    }
    const probe = await probeEndpoint(endpoint)
    if (probe.connected) {
      return result("preserved", "endpoint is responsive despite the missing process")
    }
    if (probe.error) {
      const reason = connectionFailureReason(probe.error)
      if (reason) {
        return result("preserved", reason)
      }
    }

    let checkedSocket
    try {
      checkedSocket = await inspectSocket(endpoint)
    } catch (error) {
      return result("failed", `endpoint is unsafe: ${error.message}`)
    }
    if (!sameSocketIdentity(originalSocket, checkedSocket)) {
      return result("preserved", "endpoint changed while it was being checked")
    }

    const latestRecord = await readCleanupSnapshot(instanceId).catch((error) => ({ error }))
    if (latestRecord?.error || !latestRecord) {
      return result("preserved", "record changed or disappeared while cleanup was being checked")
    }
    if (
      !sameFileIdentity(snapshot.info, latestRecord.info) ||
      !snapshot.bytes.equals(latestRecord.bytes)
    ) {
      return result("preserved", "record changed while cleanup was being checked")
    }
    const latestOwner = ownerIsAbsent(snapshot.record.pid)
    if (!latestOwner.absent) {
      return result("preserved", latestOwner.reason)
    }

    const finalProbe = await probeEndpoint(endpoint)
    if (finalProbe.connected) {
      return result("preserved", "endpoint became responsive during cleanup")
    }
    if (finalProbe.error) {
      const reason = connectionFailureReason(finalProbe.error)
      if (reason) {
        return result("preserved", reason)
      }
    }
    try {
      checkedSocket = await inspectSocket(endpoint)
    } catch (error) {
      return result("failed", `endpoint is unsafe: ${error.message}`)
    }
    if (!sameSocketIdentity(originalSocket, checkedSocket)) {
      return result("preserved", "endpoint changed while it was being checked")
    }

    if (originalSocket.exists) {
      const recordBeforeSocketUnlink = await readCleanupSnapshot(instanceId).catch((error) => ({
        error,
      }))
      if (recordBeforeSocketUnlink?.error || !recordBeforeSocketUnlink) {
        return result("preserved", "record changed or disappeared while cleanup was being checked")
      }
      if (
        !sameFileIdentity(snapshot.info, recordBeforeSocketUnlink.info) ||
        !snapshot.bytes.equals(recordBeforeSocketUnlink.bytes)
      ) {
        return result("preserved", "record changed while cleanup was being checked")
      }

      let socketBeforeUnlink
      try {
        socketBeforeUnlink = await inspectSocket(endpoint)
      } catch (error) {
        return result("failed", `endpoint is unsafe: ${error.message}`)
      }
      if (!sameSocketIdentity(originalSocket, socketBeforeUnlink)) {
        return result("preserved", "endpoint changed while it was being checked")
      }

      const ownerBeforeSocketUnlink = ownerIsAbsent(snapshot.record.pid)
      if (!ownerBeforeSocketUnlink.absent) {
        return result("preserved", ownerBeforeSocketUnlink.reason)
      }

      try {
        await unlink(endpoint)
      } catch (error) {
        if (error.code !== "ENOENT") {
          return result("failed", `could not remove stale endpoint: ${error.message}`)
        }
      }
    }

    const finalEndpointProbe = await probeEndpoint(endpoint)
    if (finalEndpointProbe.connected) {
      return result("preserved", "endpoint became responsive before the record could be removed")
    }
    if (finalEndpointProbe.error) {
      const reason = connectionFailureReason(finalEndpointProbe.error)
      if (reason) {
        return result("preserved", reason)
      }
    }
    let finalSocket
    try {
      finalSocket = await inspectSocket(endpoint)
    } catch (error) {
      return result("failed", `endpoint is unsafe: ${error.message}`)
    }
    if (originalSocket.exists && finalSocket.exists) {
      return result("preserved", "endpoint reappeared before the record could be removed")
    }
    if (!originalSocket.exists && finalSocket.exists) {
      return result("preserved", "endpoint appeared before the record could be removed")
    }

    const finalRecord = await readCleanupSnapshot(instanceId).catch((error) => ({ error }))
    if (finalRecord?.error || !finalRecord) {
      return result("preserved", "endpoint was removed, but the record changed or disappeared")
    }
    if (
      !sameFileIdentity(snapshot.info, finalRecord.info) ||
      !snapshot.bytes.equals(finalRecord.bytes)
    ) {
      return result("preserved", "endpoint was removed, but the record changed")
    }
    const finalOwner = ownerIsAbsent(snapshot.record.pid)
    if (!finalOwner.absent) {
      return result("preserved", `endpoint was removed, but ${finalOwner.reason}`)
    }

    try {
      await unlink(snapshot.file)
    } catch (error) {
      if (error.code !== "ENOENT") {
        return result("failed", `could not remove stale record: ${error.message}`)
      }
    }
    return result("removed", "stale record and endpoint removed")
  }

  async function cleanupRecords() {
    await ensurePrivateDirectory(runtimeRoot)
    await ensurePrivateDirectory(directory)
    const entries = await readdir(directory, { withFileTypes: true })
    const instanceIds = entries
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .sort()
    const results = []
    for (const instanceId of instanceIds) {
      if (!INSTANCE_ID.test(instanceId)) {
        results.push({
          instanceId,
          status: "failed",
          reason: "record filename is not a valid instance identity",
        })
        continue
      }
      try {
        results.push(await cleanupOneRecord(instanceId))
      } catch (error) {
        results.push({
          instanceId,
          status: "failed",
          reason: `cleanup failed: ${error.message}`,
        })
      }
    }
    return results
  }

  async function writeRecord(record) {
    validateRecord(record, scope)
    await writePrivateJson(recordPath(directory, record.instanceId), record)
  }

  async function removeRecord(instanceId) {
    const file = recordPath(directory, instanceId)
    await assertPrivateFile(file)
    await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  async function serve(instanceId, handler, onError = () => {}) {
    const file = socketPath(directory, instanceId)
    const clients = new Set()
    const server = net.createServer((socket) => {
      clients.add(socket)
      socket.setEncoding("utf8")
      socket.setTimeout(REQUEST_TIMEOUT_MS, () =>
        socket.destroy(new Error("IPC request timed out"))
      )
      let bytes = 0
      let input = ""
      let handled = false
      socket.on("close", () => clients.delete(socket))
      socket.on("error", (error) => onError(error))
      socket.on("data", async (chunk) => {
        if (handled) return
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_FRAME_BYTES) {
          handled = true
          socket.end(
            encodeFrame({
              version: 1,
              instanceId,
              requestId: "",
              ok: false,
              error: { code: "FRAME_TOO_LARGE", message: "IPC frame exceeds the maximum size" },
            })
          )
          return
        }
        input += chunk.toString("utf8")
        const newline = input.indexOf("\n")
        if (newline === -1) return
        handled = true
        try {
          const request = validateRequest(JSON.parse(input.slice(0, newline)))
          if (request.instanceId !== instanceId)
            throw new ProtocolError("INSTANCE_MISMATCH", "Request targets a different instance")
          let response
          let afterReply
          try {
            const result = await handler(request)
            response = {
              version: 1,
              instanceId,
              requestId: request.requestId,
              ok: true,
              data: result?.data,
            }
            afterReply = result?.afterReply
          } catch (error) {
            response = sendError(error, request)
          }
          const frame = encodeFrame(response)
          socket.end(frame, () => {
            if (typeof afterReply === "function") Promise.resolve().then(afterReply).catch(onError)
          })
        } catch (error) {
          onError(error)
          if (!socket.destroyed)
            socket.end(encodeFrame(sendError(error, { instanceId, requestId: "" })))
        }
      })
    })
    const ready = Promise.withResolvers()
    server.on("error", (error) => {
      ready.reject(error)
      onError(error)
    })
    server.listen(file, () => {
      chmod(file, 0o600).then(ready.resolve, ready.reject)
    })
    try {
      await ready.promise
    } catch (error) {
      if (server.listening) server.close()
      throw error
    }
    return {
      async close() {
        for (const client of clients) client.destroy()
        if (server.listening) {
          const done = Promise.withResolvers()
          server.close(() => done.resolve())
          await done.promise
        }
        await unlink(file).catch((error) => {
          if (error.code !== "ENOENT") throw error
        })
      },
    }
  }

  function request(record, request, { signal } = {}) {
    validateRecord(record, scope)
    const requestValue = validateRequest(request)
    if (requestValue.instanceId !== record.instanceId)
      throw new Error("Request instance does not match target record")
    const file = socketPath(directory, record.instanceId)
    const frame = encodeFrame(requestValue)
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }

      const socket = net.createConnection(file)
      socket.setEncoding("utf8")
      let input = ""
      let bytes = 0
      let finished = false
      let timer
      const finish = (error, value, rejectError = false) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", handleAbort)
        socket.destroy()
        if (rejectError || error) {
          reject(error)
        } else {
          resolve(value)
        }
      }
      const handleAbort = () => finish(signal.reason, undefined, true)
      timer = setTimeout(
        () =>
          finish(
            Object.assign(new Error("IPC response timed out; request outcome is unknown"), {
              code: "ETIMEDOUT",
              ambiguous: true,
            })
          ),
        REQUEST_TIMEOUT_MS
      )
      signal?.addEventListener("abort", handleAbort, { once: true })
      if (signal?.aborted) {
        handleAbort()
        return
      }

      socket.setTimeout(REQUEST_TIMEOUT_MS, () =>
        finish(
          Object.assign(new Error("IPC response timed out; request outcome is unknown"), {
            code: "ETIMEDOUT",
            ambiguous: true,
          })
        )
      )
      socket.on("error", (error) => finish(error))
      socket.on("close", () =>
        finish(
          Object.assign(
            new Error("IPC connection closed before acknowledgement; request outcome is unknown"),
            { code: "ECONNRESET", ambiguous: true }
          )
        )
      )
      socket.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_FRAME_BYTES) {
          finish(new Error("IPC response exceeds the maximum size"))
          return
        }
        input += chunk.toString("utf8")
        const newline = input.indexOf("\n")
        if (newline === -1) return
        try {
          const response = validateResponse(JSON.parse(input.slice(0, newline)), requestValue)
          finish(null, response)
        } catch (error) {
          finish(
            Object.assign(
              new Error(
                `Invalid IPC acknowledgement; request outcome is unknown: ${error.message}`,
                {
                  cause: error,
                }
              ),
              { code: error.code, ambiguous: true }
            )
          )
        }
      })
      socket.on("connect", () => {
        if (!finished) {
          socket.write(frame)
        }
      })
    })
  }

  return {
    scope,
    directory,
    readRecords,
    writeRecord,
    removeRecord,
    cleanupRecords,
    serve,
    request,
  }
}
