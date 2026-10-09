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

  function request(record, request) {
    validateRecord(record, scope)
    const requestValue = validateRequest(request)
    if (requestValue.instanceId !== record.instanceId)
      throw new Error("Request instance does not match target record")
    const file = socketPath(directory, record.instanceId)
    const frame = encodeFrame(requestValue)
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(file)
      socket.setEncoding("utf8")
      let input = ""
      let bytes = 0
      let finished = false
      const timer = setTimeout(
        () =>
          finish(
            Object.assign(new Error("IPC response timed out; request outcome is unknown"), {
              code: "ETIMEDOUT",
              ambiguous: true,
            })
          ),
        REQUEST_TIMEOUT_MS
      )
      const finish = (error, value) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(value)
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
      socket.on("connect", () => socket.write(frame))
    })
  }

  return { scope, directory, readRecords, writeRecord, removeRecord, serve, request }
}
