import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import instanceControl from "../../omp/index.js"
import { createRequest, getScope } from "../../protocol/index.js"

function createEventBus() {
  const listeners = new Map()
  return {
    emit(channel, value) {
      for (const listener of listeners.get(channel) ?? []) {
        listener(value)
      }
    },
    on(channel, listener) {
      let channelListeners = listeners.get(channel)
      if (!channelListeners) {
        channelListeners = new Set()
        listeners.set(channel, channelListeners)
      }
      channelListeners.add(listener)
      return () => channelListeners.delete(listener)
    },
  }
}

function createSdk() {
  return {
    KeybindingsManager: {
      inMemory() {
        return { matches: () => false }
      },
    },
  }
}

test("when agent-end arrives during shutdown, removed endpoint records stay removed", async () => {
  // Arrange
  const root = await mkdtemp(path.join(tmpdir(), "ic-life-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "1".repeat(32)
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    lastRestart: null,
    builtinFlags: [],
  })
  const environment = {
    HOME: root,
    PI_CONFIG_DIR: path.join(root, ".omp"),
    PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent"),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    XDG_RUNTIME_DIR: root,
    OMP_INSTANCE_CONTROL_LAUNCH_DIR: launchDirectory,
    OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: token,
  }
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, environment)
  const handlers = new Map()
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: { getSessionId: () => "persisted-session", getSessionFile: () => null },
    ui: {
      setStatus() {},
      notify(message) {
        assert.fail(message)
      },
    },
  }
  try {
    await instanceControl({
      events: createEventBus(),
      pi: createSdk(),
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    })
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)

    // Act
    const closing = handlers.get("session_shutdown")({}, ctx)
    await handlers.get("agent_end")({}, ctx)
    await closing

    // Assert
    assert.deepEqual(await transport.readRecords(), [])
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("when restart arrives before the first saved response, it waits for persistence and coalesces requests", async () => {
  // Arrange
  const root = await mkdtemp(path.join(tmpdir(), "ic-first-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "2".repeat(32)
  const sessionFile = path.join(root, "first-session.jsonl")
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    lastRestart: null,
    builtinFlags: [],
  })
  const environment = {
    HOME: root,
    PI_CONFIG_DIR: path.join(root, ".omp"),
    PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent"),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    XDG_RUNTIME_DIR: root,
    OMP_INSTANCE_CONTROL_LAUNCH_DIR: launchDirectory,
    OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: token,
  }
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, environment)
  const handlers = new Map()
  const events = createEventBus()
  let shutdowns = 0
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: {
      getSessionId: () => "first-session",
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus() {},
      notify(message) {
        assert.fail(message)
      },
    },
    shutdown() {
      shutdowns += 1
    },
  }
  try {
    await instanceControl({
      events,
      pi: createSdk(),
      runtime: { flagValues: new Map() },
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    })
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    const request = createRequest(record.instanceId, "restart")
    // Act
    const accepted = await transport.request(record, request)
    const duplicate = await transport.request(record, createRequest(record.instanceId, "restart"))
    const pending = await transport.request(record, createRequest(record.instanceId, "status"))
    events.emit("omp-exit-command:exit-requested", { sessionId: "other-session" })
    const shutdownsBeforePersistence = shutdowns
    await writeFile(sessionFile, '{"type":"session","id":"first-session"}\n', { mode: 0o600 })
    await handlers.get("agent_end")({}, ctx)
    const shutdownsAfterPersistence = shutdowns
    await handlers.get("agent_end")({}, ctx)
    await handlers.get("session_shutdown")({}, ctx)
    const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))

    // Assert
    assert.equal(accepted.ok, true)
    assert.equal(accepted.data.operationId, request.requestId)
    assert.equal(duplicate.data.operationId, request.requestId)
    assert.equal(pending.data.state, "restart-requested")
    assert.equal(pending.data.canRestart, false)
    assert.equal(shutdownsBeforePersistence, 0)
    assert.equal(shutdowns, 1)
    assert.equal(shutdownsAfterPersistence, 1)
    assert.equal(handoff.operationId, request.requestId)
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("when an explicit matching exit arrives after restart acceptance, shutdown does not hand off", async () => {
  // Arrange
  const root = await mkdtemp(path.join(tmpdir(), "ic-exit-precedence-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "3".repeat(32)
  const sessionFile = path.join(root, "session.jsonl")
  await writeFile(sessionFile, '{"type":"session","id":"exit-session"}\n', { mode: 0o600 })
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    lastRestart: null,
    builtinFlags: [],
  })
  const environment = {
    HOME: root,
    PI_CONFIG_DIR: path.join(root, ".omp"),
    PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent"),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    XDG_RUNTIME_DIR: root,
    OMP_INSTANCE_CONTROL_LAUNCH_DIR: launchDirectory,
    OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: token,
  }
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, environment)
  const events = createEventBus()
  const handlers = new Map()
  let shutdowns = 0
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: {
      getSessionId: () => "exit-session",
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus() {},
      notify(message) {
        assert.fail(message)
      },
    },
    shutdown() {
      shutdowns += 1
    },
  }

  try {
    await instanceControl({
      events,
      pi: createSdk(),
      runtime: { flagValues: new Map() },
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    })
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    const request = createRequest(record.instanceId, "restart")

    // Act
    const accepted = await transport.request(record, request)
    events.emit("omp-exit-command:exit-requested", { sessionId: "exit-session" })
    const status = await transport.request(record, createRequest(record.instanceId, "status"))
    const rejected = await transport.request(record, createRequest(record.instanceId, "restart"))
    await handlers.get("session_shutdown")({}, ctx)
    const handoff = readFile(path.join(launchDirectory, "handoff.json"))

    // Assert
    assert.equal(accepted.ok, true)
    assert.equal(accepted.data.operationId, request.requestId)
    assert.equal(shutdowns, 1)
    assert.equal(status.data.canRestart, false)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, "EXPLICIT_EXIT_REQUESTED")
    await assert.rejects(handoff, { code: "ENOENT" })
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
