import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"
import { ProtocolError } from "../../protocol/index.js"
import {
  createTransport,
  ensurePrivateDirectory,
  readPrivateJson,
  writePrivateJson,
} from "../../linux/transport.js"

const INSTANCE_A = "a".repeat(32)
const INSTANCE_B = "b".repeat(32)
const SCOPE_A = { id: "1".repeat(32) }
const SCOPE_B = { id: "2".repeat(32) }
const roots = []

async function createRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-transport-test-"))
  roots.push(root)
  return root
}

function makeRecord(scope, instanceId = INSTANCE_A) {
  return {
    version: 1,
    instanceId,
    scope: scope.id,
    pid: process.pid,
    cwd: process.cwd(),
    sessionId: "session",
    sessionFile: "/tmp/session.jsonl",
    launcherManaged: true,
    state: "running",
    lastRestart: null,
  }
}

function makeRequest(instanceId = INSTANCE_A, requestId = "request-1") {
  return { version: 1, instanceId, requestId, action: "status" }
}

function transportFor(root, scope) {
  return createTransport(scope, { env: { ...process.env, XDG_RUNTIME_DIR: root } })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("private directory and JSON operations refuse permissive paths and symlink targets", async () => {
  const root = await createRoot()
  const permissive = path.join(root, "permissive")
  await mkdir(permissive, { mode: 0o700 })
  await chmod(permissive, 0o755)
  await assert.rejects(ensurePrivateDirectory(permissive), /accessible by other users/)

  const privateDirectory = path.join(root, "private")
  await ensurePrivateDirectory(privateDirectory)
  const target = path.join(root, "outside.json")
  await writeFile(target, "original", { mode: 0o600 })
  const link = path.join(privateDirectory, "record.json")
  await symlink(target, link)
  await assert.rejects(writePrivateJson(link, { replaced: true }), /Unsafe private file/)
  await assert.rejects(readPrivateJson(link), /Unsafe private file/)
  assert.equal(await readFile(target, "utf8"), "original")
})

test("real socket dispatch returns handler protocol errors and rejects wrong instance identities", async () => {
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const record = makeRecord(SCOPE_A)
  await transport.writeRecord(record)
  const server = await transport.serve(INSTANCE_A, async (request) => {
    assert.equal(request.action, "status")
    throw new ProtocolError("NOT_READY", "The instance is not ready")
  })
  try {
    const response = await transport.request(record, makeRequest())
    assert.deepEqual(response, {
      version: 1,
      instanceId: INSTANCE_A,
      requestId: "request-1",
      ok: false,
      error: { code: "NOT_READY", message: "The instance is not ready" },
    })

    const mismatch = await new Promise((resolve, reject) => {
      const socket = net.createConnection(path.join(transport.directory, `${INSTANCE_A}.sock`))
      let input = ""
      socket.on("error", reject)
      socket.on("data", (chunk) => {
        input += chunk.toString("utf8")
        const newline = input.indexOf("\n")
        if (newline !== -1) {
          socket.destroy()
          resolve(JSON.parse(input.slice(0, newline)))
        }
      })
      socket.on("connect", () =>
        socket.write(`${JSON.stringify(makeRequest(INSTANCE_B, "wrong-instance"))}\n`)
      )
    })
    assert.equal(mismatch.instanceId, INSTANCE_A)
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.error.code, "INSTANCE_MISMATCH")
  } finally {
    await server.close()
  }
})

test("client rejects a response with mismatched instance or request identity", async () => {
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const record = makeRecord(SCOPE_A)
  await transport.writeRecord(record)
  const socketPath = path.join(transport.directory, `${INSTANCE_A}.sock`)

  for (const response of [
    { version: 1, instanceId: INSTANCE_B, requestId: "request-1", ok: true, data: {} },
    { version: 1, instanceId: INSTANCE_A, requestId: "different-request", ok: true, data: {} },
  ]) {
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.end(`${JSON.stringify(response)}\n`))
    })
    await new Promise((resolve) => server.listen(socketPath, resolve))
    try {
      await assert.rejects(transport.request(record, makeRequest()), /instance|request/i)
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
})

test("records and sockets are isolated by scope, and close destroys pending clients", async () => {
  const root = await createRoot()
  const first = await transportFor(root, SCOPE_A)
  const second = await transportFor(root, SCOPE_B)
  await first.writeRecord(makeRecord(SCOPE_A))
  await second.writeRecord(makeRecord(SCOPE_B))
  assert.deepEqual(
    (await first.readRecords()).map(({ scope }) => scope),
    [SCOPE_A.id]
  )
  assert.deepEqual(
    (await second.readRecords()).map(({ scope }) => scope),
    [SCOPE_B.id]
  )
  await assert.rejects(second.request(makeRecord(SCOPE_B), makeRequest()), { code: "ENOENT" })

  const server = await first.serve(INSTANCE_A, () => new Promise(() => {}))
  const pending = first.request(makeRecord(SCOPE_A), makeRequest())
  const rejected = assert.rejects(pending)
  await new Promise((resolve) => setTimeout(resolve, 25))
  await server.close()
  await rejected
})
