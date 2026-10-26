import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fsPromises from "node:fs/promises"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { afterEach, test } from "node:test"

import { listInstances, restartInstances } from "../../cli/client.js"
import {
  createTransport,
  ensurePrivateDirectory,
  readPrivateJson,
  readSendContextMetadata,
  writePrivateJson,
} from "../../linux/transport.js"
import { ProtocolError } from "../../protocol/index.js"

const INSTANCE_A = "a".repeat(32)
const INSTANCE_B = "b".repeat(32)
const INSTANCE_C = "c".repeat(32)
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

test("when Send Context health matches its private per-console identity, listing exposes only loaded metadata", async (t) => {
  // Arrange
  const root = await createRoot()
  t.mock.method(os, "homedir", () => root)
  const bridgeId = INSTANCE_C
  const requests = []
  const health = {
    ok: true,
    instanceId: bridgeId,
    pid: process.pid,
    endpoint: "http://127.0.0.1:47687",
    version: "2.8.0",
    protocolVersion: 1,
  }
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    })
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify(health))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  health.endpoint = endpoint
  const directory = path.join(root, ".omp", "agent", "editor-context-bridge.json.d")
  await ensurePrivateDirectory(directory)
  await writePrivateJson(path.join(directory, `${bridgeId}.json`), {
    endpoint,
    instanceId: bridgeId,
    pid: process.pid,
    version: "installed-package-version",
    protocolVersion: 1,
    token: "never-return-this",
  })
  const controlRecord = makeRecord(SCOPE_A, INSTANCE_A)

  try {
    // Act
    const metadata = await readSendContextMetadata(controlRecord)

    // Assert
    assert.deepEqual(metadata, { version: "2.8.0", protocolVersion: 1 })
    assert.deepEqual(requests, [{ method: "GET", url: "/health", authorization: undefined }])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("when Send Context metadata is absent, listing keeps it unknown without creating state", async (t) => {
  // Arrange
  const root = await createRoot()
  t.mock.method(os, "homedir", () => root)
  const controlRecord = makeRecord(SCOPE_A, INSTANCE_A)
  const directory = path.join(root, ".omp", "agent", "editor-context-bridge.json.d")

  // Act
  const metadata = await readSendContextMetadata(controlRecord)

  // Assert
  assert.equal(metadata, null)
  await assert.rejects(fsPromises.lstat(directory), { code: "ENOENT" })
})

test("when Send Context metadata lives under a symlink, listing keeps it unknown", async (t) => {
  // Arrange
  const root = await createRoot()
  t.mock.method(os, "homedir", () => root)
  const agentDirectory = path.join(root, ".omp", "agent")
  const outsideDirectory = path.join(root, "outside")
  const directory = path.join(agentDirectory, "editor-context-bridge.json.d")
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 })
  await mkdir(outsideDirectory, { mode: 0o700 })
  await symlink(outsideDirectory, directory)
  const controlRecord = makeRecord(SCOPE_A, INSTANCE_A)

  // Act
  const metadata = await readSendContextMetadata(controlRecord)

  // Assert
  assert.equal(metadata, null)
})

test("when private metadata or live health is invalid, listing keeps metadata unknown", async (t) => {
  // Arrange
  const root = await createRoot()
  t.mock.method(os, "homedir", () => root)
  const controlRecord = makeRecord(SCOPE_A, INSTANCE_A)
  const directory = path.join(root, ".omp", "agent", "editor-context-bridge.json.d")
  await ensurePrivateDirectory(directory)
  const bridgeId = INSTANCE_C
  const health = {
    ok: true,
    instanceId: bridgeId,
    pid: process.pid,
    endpoint: "http://127.0.0.1:47687",
    version: "2.8.0",
    protocolVersion: 1,
  }
  const requests = []
  let responseStatus = 200
  let responseHealth = health
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    })
    response.writeHead(responseStatus, { "Content-Type": "application/json" })
    response.end(JSON.stringify(responseHealth))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  health.endpoint = endpoint
  const statePath = path.join(directory, `${bridgeId}.json`)

  try {
    // Act / Assert
    await writePrivateJson(statePath, {
      endpoint,
      instanceId: bridgeId,
      pid: controlRecord.pid + 1,
      token: "never-return-this",
    })
    assert.equal(await readSendContextMetadata(controlRecord), null)
    assert.equal(requests.length, 0)

    await writePrivateJson(statePath, {
      endpoint,
      instanceId: bridgeId,
      pid: controlRecord.pid,
      token: "never-return-this",
    })
    const withoutVersion = { ...health }
    delete withoutVersion.version
    const withoutProtocol = { ...health }
    delete withoutProtocol.protocolVersion
    for (const [name, status, body] of [
      ["mismatched bridge identity", 200, { ...health, instanceId: INSTANCE_B }],
      ["reused endpoint PID", 200, { ...health, pid: health.pid + 1 }],
      ["missing loaded version", 200, withoutVersion],
      ["unknown loaded version", 200, { ...health, version: "unknown" }],
      ["missing routing protocol", 200, withoutProtocol],
      ["unhealthy endpoint", 503, health],
    ]) {
      responseStatus = status
      responseHealth = body
      assert.equal(await readSendContextMetadata(controlRecord), null, name)
    }

    assert.ok(
      requests.every(
        ({ method, url, authorization }) =>
          method === "GET" && url === "/health" && authorization === undefined
      )
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("when private paths are permissive or symlinked, filesystem operations reject them", async () => {
  // Arrange
  const root = await createRoot()
  const permissive = path.join(root, "permissive")
  await mkdir(permissive, { mode: 0o700 })
  await chmod(permissive, 0o755)
  // Act / Assert
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

test("when a record disappears after enumeration, discovery keeps surviving instances", async (t) => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  await transport.writeRecord(makeRecord(SCOPE_A, INSTANCE_A))
  await transport.writeRecord(makeRecord(SCOPE_A, INSTANCE_B))
  const readdir = fsPromises.readdir
  const enumeration = t.mock.method(fsPromises, "readdir", async (...args) => {
    const entries = await readdir(...args)
    if (args[0] === transport.directory) {
      await fsPromises.unlink(path.join(transport.directory, `${INSTANCE_B}.json`))
    }
    return entries
  })
  syncBuiltinESMExports()
  try {
    // Act / Assert
    assert.deepEqual(
      (await transport.readRecords()).map((record) => record.instanceId),
      [INSTANCE_A]
    )
  } finally {
    enumeration.mock.restore()
    syncBuiltinESMExports()
  }
})

test("when socket requests fail admission, dispatch reports protocol errors and identity mismatches", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const record = makeRecord(SCOPE_A)
  await transport.writeRecord(record)
  const server = await transport.serve(INSTANCE_A, async (request) => {
    assert.equal(request.action, "status")
    throw new ProtocolError("NOT_READY", "The instance is not ready")
  })
  try {
    // Act
    const response = await transport.request(record, makeRequest())
    // Assert
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

test("when acknowledgements are invalid or rejected, clients report unknown or failed outcomes", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const record = makeRecord(SCOPE_A)
  await transport.writeRecord(record)
  const socketPath = path.join(transport.directory, `${INSTANCE_A}.sock`)

  // Act / Assert
  for (const { reply, status } of [
    { reply: { instanceId: INSTANCE_B, ok: true, data: {} }, status: "unknown" },
    { reply: { requestId: "different-request", ok: true, data: {} }, status: "unknown" },
    { reply: { ok: true, data: null }, status: "unknown" },
    {
      reply: { ok: false, error: { code: "NOT_READY", message: "The instance is not ready" } },
      status: "failed",
    },
  ]) {
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8"))
        socket.end(
          `${JSON.stringify({
            version: 1,
            instanceId: INSTANCE_A,
            requestId: request.requestId,
            ...reply,
          })}\n`
        )
      })
    })
    await new Promise((resolve) => server.listen(socketPath, resolve))
    try {
      assert.equal((await listInstances(transport))[0].status, status)
      assert.equal(
        (await restartInstances(transport, { instanceId: INSTANCE_A }))[0].status,
        status
      )
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
})

test("when transports use different scopes, records remain isolated and closing releases clients", async () => {
  // Arrange
  const root = await createRoot()
  const first = await transportFor(root, SCOPE_A)
  const second = await transportFor(root, SCOPE_B)
  await first.writeRecord(makeRecord(SCOPE_A))
  await second.writeRecord(makeRecord(SCOPE_B))
  // Act / Assert
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

test("when a socket probe is blocked, cancellation interrupts the request", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const record = makeRecord(SCOPE_A)
  await transport.writeRecord(record)
  const requestReceived = Promise.withResolvers()
  const server = await transport.serve(INSTANCE_A, async (request) => {
    assert.equal(request.action, "status")
    requestReceived.resolve()
    return new Promise(() => {})
  })
  const controller = new AbortController()
  const cancellation = new Error("stop probing")

  try {
    // Act
    const pending = transport.request(record, makeRequest(), { signal: controller.signal })
    const rejected = assert.rejects(pending, (error) => error === cancellation)
    await requestReceived.promise
    controller.abort(cancellation)
    // Assert
    await rejected
  } finally {
    await server.close()
  }
})

test("when a validated record's owner is absent, cleanup removes the record", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const record = { ...makeRecord(SCOPE_A), pid: spawnSync("/usr/bin/true").pid }
  await transport.writeRecord(record)

  // Act
  const results = await transport.cleanupRecords()

  // Assert
  assert.deepEqual(
    results.map(({ instanceId, status }) => ({ instanceId, status })),
    [{ instanceId: INSTANCE_A, status: "removed" }]
  )
  await assert.rejects(readPrivateJson(path.join(transport.directory, `${INSTANCE_A}.json`)), {
    code: "ENOENT",
  })
})

test("when a stale socket refuses connections and its owner is absent, cleanup removes both artifacts", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const endpoint = path.join(transport.directory, `${INSTANCE_A}.sock`)
  const detachedEndpoint = `${endpoint}.detached`
  await transport.writeRecord({ ...makeRecord(SCOPE_A), pid: spawnSync("/usr/bin/true").pid })

  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, resolve)
  })
  await fsPromises.rename(endpoint, detachedEndpoint)
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  await fsPromises.rename(detachedEndpoint, endpoint)
  await chmod(endpoint, 0o600)

  assert.equal((await fsPromises.lstat(endpoint)).isSocket(), true)
  // Act
  const results = await transport.cleanupRecords()

  // Assert
  assert.deepEqual(
    results.map(({ instanceId, status }) => [instanceId, status]),
    [[INSTANCE_A, "removed"]]
  )
  await assert.rejects(fsPromises.lstat(endpoint), { code: "ENOENT" })
  await assert.rejects(readPrivateJson(path.join(transport.directory, `${INSTANCE_A}.json`)), {
    code: "ENOENT",
  })
})

test("when an owner is live or its endpoint responds, cleanup preserves the registration", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const liveRecord = makeRecord(SCOPE_A, INSTANCE_A)
  const deadPID = spawnSync("/usr/bin/true").pid
  const responsiveRecord = { ...makeRecord(SCOPE_A, INSTANCE_B), pid: deadPID }
  await transport.writeRecord(liveRecord)
  await transport.writeRecord(responsiveRecord)
  const server = await transport.serve(INSTANCE_B, async () => ({ data: {} }))

  try {
    // Act
    const results = await transport.cleanupRecords()

    // Assert
    assert.deepEqual(
      results.map(({ instanceId, status }) => [instanceId, status]),
      [
        [INSTANCE_A, "preserved"],
        [INSTANCE_B, "preserved"],
      ]
    )
    assert.equal(
      (await readPrivateJson(path.join(transport.directory, `${INSTANCE_A}.json`))).pid,
      process.pid
    )
    assert.equal(
      (await readPrivateJson(path.join(transport.directory, `${INSTANCE_B}.json`))).pid,
      deadPID
    )
  } finally {
    await server.close()
  }
})

test("when records or sockets are unsafe, cleanup preserves them and continues eligible records", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const invalidRecordPath = path.join(transport.directory, `${INSTANCE_A}.json`)
  const unsafeEndpoint = path.join(transport.directory, `${INSTANCE_B}.sock`)
  const outsideFile = path.join(root, "outside")
  await writeFile(invalidRecordPath, "{", { mode: 0o600 })
  await transport.writeRecord({
    ...makeRecord(SCOPE_A, INSTANCE_B),
    pid: spawnSync("/usr/bin/true").pid,
  })
  await writeFile(outsideFile, "keep this file", { mode: 0o600 })
  await symlink(outsideFile, unsafeEndpoint)
  await transport.writeRecord({
    ...makeRecord(SCOPE_A, INSTANCE_C),
    pid: spawnSync("/usr/bin/true").pid,
  })

  // Act
  const results = await transport.cleanupRecords()

  // Assert
  assert.deepEqual(
    results.map(({ instanceId, status }) => [instanceId, status]),
    [
      [INSTANCE_A, "failed"],
      [INSTANCE_B, "failed"],
      [INSTANCE_C, "removed"],
    ]
  )
  assert.equal(await readFile(outsideFile, "utf8"), "keep this file")
  assert.equal(
    (await readPrivateJson(path.join(transport.directory, `${INSTANCE_B}.json`))).instanceId,
    INSTANCE_B
  )
  await assert.rejects(readPrivateJson(path.join(transport.directory, `${INSTANCE_C}.json`)), {
    code: "ENOENT",
  })
})

test("when a socket has no discovery record, cleanup leaves it untouched", async () => {
  // Arrange
  const root = await createRoot()
  const transport = await transportFor(root, SCOPE_A)
  const endpoint = path.join(transport.directory, `${INSTANCE_A}.sock`)
  const server = await transport.serve(INSTANCE_A, async () => ({ data: {} }))

  try {
    // Act / Assert
    assert.deepEqual(await transport.cleanupRecords(), [])
    assert.equal((await fsPromises.lstat(endpoint)).isSocket(), true)
  } finally {
    await server.close()
  }
})
