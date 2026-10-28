import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import { createRequest, getScope } from "../../protocol/index.js"
import { createEventBus, createExtensionApi, createSdk } from "./lifecycle-fixture.js"

import instanceControl from "../../omp/index.js"

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

test("when status is queried, it exposes loaded Send Context health metadata or explicit unknown", async () => {
  // Arrange
  const root = await mkdtemp(path.join(tmpdir(), "ic-send-context-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "3".repeat(32)
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
  const healthRequests = []
  const bridgeId = "c".repeat(32)
  const server = http.createServer((request, response) => {
    healthRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    })
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        ok: true,
        instanceId: bridgeId,
        endpoint: `http://127.0.0.1:${server.address().port}`,
        pid: process.pid,
        version: "2.8.0",
        protocolVersion: 1,
      })
    )
  })
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: { getSessionId: () => "status-session", getSessionFile: () => null },
    ui: {
      setStatus() {},
      notify(message) {
        assert.fail(message)
      },
    },
  }

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
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
    const [record] = await transport.readRecords()
    const endpoint = `http://127.0.0.1:${server.address().port}`
    const statePath = path.join(
      root,
      ".omp",
      "agent",
      "editor-context-bridge.json.d",
      `${bridgeId}.json`
    )
    await writePrivateJson(statePath, {
      endpoint,
      instanceId: bridgeId,
      pid: record.pid,
      version: "installed-package-version",
      protocolVersion: 1,
      token: "never-return-this",
    })

    // Act
    const response = await transport.request(record, createRequest(record.instanceId, "status"))

    // Assert
    assert.equal(response.ok, true)
    assert.equal(response.data.instanceId, record.instanceId)
    assert.deepEqual(response.data.sendContext, { version: "2.8.0", protocolVersion: 1 })
    assert.deepEqual(healthRequests, [{ method: "GET", url: "/health", authorization: undefined }])
    assert.equal(JSON.stringify(response).includes("never-return-this"), false)

    // Act
    await rm(statePath)
    const withoutPrivateState = await transport.request(
      record,
      createRequest(record.instanceId, "status")
    )

    // Assert
    assert.equal(withoutPrivateState.ok, true)
    assert.equal(withoutPrivateState.data.sendContext, null)
    assert.equal(JSON.stringify(withoutPrivateState).includes("never-return-this"), false)
    assert.equal(healthRequests.length, 1)
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("when the first transcript is missing, restart waits for persistence and refuses a changed context", async () => {
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
  const extension = createExtensionApi(events, handlers, ctx)
  try {
    await instanceControl(extension.api)
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    const request = createRequest(record.instanceId, "restart")

    // Act
    const accepted = await transport.request(record, request)
    const duplicate = await transport.request(record, createRequest(record.instanceId, "restart"))
    const pending = await transport.request(record, createRequest(record.instanceId, "status"))
    const shutdownsBeforePersistence = shutdowns
    await writeFile(sessionFile, '{"type":"session","id":"first-session"}\n', { mode: 0o600 })
    await handlers.get("agent_end")({}, ctx)
    const shutdownsAfterPersistence = shutdowns
    ctx.cwd = path.join(root, "different-working-directory")
    await handlers.get("session_switch")({}, ctx)
    const shutdownsAfterContextChange = shutdowns
    await handlers.get("session_shutdown")({}, ctx)

    // Assert
    assert.equal(accepted.ok, true)
    assert.equal(accepted.data.operationId, request.requestId)
    assert.equal(duplicate.data.operationId, request.requestId)
    assert.equal(pending.data.state, "restart-requested")
    assert.equal(pending.data.canRestart, false)
    assert.equal(shutdownsBeforePersistence, 0)
    assert.equal(shutdownsAfterPersistence, 1)
    assert.equal(shutdownsAfterContextChange, 1)
    await assert.rejects(readFile(path.join(launchDirectory, "handoff.json")), { code: "ENOENT" })
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("when wrapper restart is pending, a child-only request cannot downgrade its handoff", async () => {
  // Arrange
  const root = await mkdtemp(path.join(tmpdir(), "ic-wrapper-restart-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "8".repeat(32)
  const sessionFile = path.join(root, "wrapper-session.jsonl")
  await writeFile(sessionFile, '{"type":"session","id":"wrapper-session"}\n', { mode: 0o600 })
  const executable = path.join(root, "ompi")
  await writeFile(executable, "#!/bin/sh\nprintf 'ompi 0.18.0\\n'\n", { mode: 0o700 })
  const nativeImage = await stat(executable, { bigint: true })
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    canRestartWrapper: true,
    lastRestart: null,
    builtinFlags: [],
    native: {
      executable,
      version: "0.18.0",
      device: nativeImage.dev.toString(),
      inode: nativeImage.ino.toString(),
    },
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
  const shutdownRequested = Promise.withResolvers()
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: {
      getSessionId: () => "wrapper-session",
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus() {},
      notify(message) {
        assert.fail(message)
      },
    },
    shutdown() {
      shutdownRequested.resolve()
    },
  }
  const extension = createExtensionApi(events, handlers, ctx)

  try {
    await instanceControl(extension.api)
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    const request = createRequest(record.instanceId, "restart-wrapper")

    // Act
    const accepted = await transport.request(record, request)
    await shutdownRequested.promise
    const conflicting = await transport.request(record, createRequest(record.instanceId, "restart"))
    await handlers.get("session_shutdown")({}, ctx)
    const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))

    // Assert
    assert.equal(accepted.ok, true)
    assert.equal(accepted.requestId, request.requestId)
    assert.equal(accepted.data.operationId, request.requestId)
    assert.equal(conflicting.ok, false)
    assert.equal(conflicting.error.code, "RESTART_ALREADY_PENDING")
    assert.equal(handoff.operationId, request.requestId)
    assert.equal(handoff.instanceId, record.instanceId)
    assert.equal(handoff.restartWrapper, true)
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("when an explicit matching exit arrives after restart acceptance, wrapper restart is rejected", async () => {
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
    canRestartWrapper: true,
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
    shutdown() {},
  }
  const extension = createExtensionApi(events, handlers, ctx)

  try {
    await instanceControl(extension.api)
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    const request = createRequest(record.instanceId, "restart")

    // Act
    const accepted = await transport.request(record, request)
    events.emit("omp-exit-command:exit-requested", { sessionId: "exit-session" })
    const status = await transport.request(record, createRequest(record.instanceId, "status"))
    const rejected = await transport.request(record, createRequest(record.instanceId, "restart"))
    const rejectedWrapper = await transport.request(
      record,
      createRequest(record.instanceId, "restart-wrapper")
    )
    await handlers.get("session_shutdown")({}, ctx)

    // Assert
    assert.equal(accepted.ok, true)
    assert.equal(accepted.data.operationId, request.requestId)
    assert.equal(status.data.canRestart, false)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, "EXPLICIT_EXIT_REQUESTED")
    assert.equal(rejectedWrapper.ok, false)
    assert.equal(rejectedWrapper.error.code, "EXPLICIT_EXIT_REQUESTED")
    await assert.rejects(readFile(path.join(launchDirectory, "handoff.json")), { code: "ENOENT" })
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("when an installed update appears during manual restart, it only notifies and keeps the accepted image pinned", async () => {
  // Arrange
  const root = await mkdtemp(path.join(tmpdir(), "ic-native-notify-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "4".repeat(32)
  const executable = path.join(root, "ompi")
  await writeFile(executable, "#!/bin/sh\nprintf 'ompi 0.16.0\\n'\n", { mode: 0o700 })
  const acceptedImage = await stat(executable, { bigint: true })
  const sessionFile = path.join(root, "session.jsonl")
  await writeFile(sessionFile, '{"type":"session","id":"automatic-session"}\n', { mode: 0o600 })
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    canRestartWrapper: true,
    lastRestart: null,
    builtinFlags: [],
    native: {
      executable,
      version: "0.16.0",
      device: acceptedImage.dev.toString(),
      inode: acceptedImage.ino.toString(),
    },
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
  const notifications = []
  const shutdownRequested = Promise.withResolvers()
  let shutdowns = 0
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: {
      getSessionId: () => "automatic-session",
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus() {},
      notify(message, level) {
        notifications.push({ message, level })
      },
    },
    shutdown() {
      shutdowns += 1
      shutdownRequested.resolve()
    },
  }
  const extension = createExtensionApi(events, handlers, ctx)
  try {
    await instanceControl(extension.api)
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    const replacement = `${executable}.new`
    await writeFile(replacement, "#!/bin/sh\nprintf 'ompi 0.17.0\\n'\n", { mode: 0o700 })

    // Act
    const manual = await transport.request(
      record,
      createRequest(record.instanceId, "restart-wrapper")
    )
    await shutdownRequested.promise
    await rename(replacement, executable)
    const deadline = performance.now() + 10_000
    let status
    do {
      status = await transport.request(record, createRequest(record.instanceId, "status"))
      if (status.data.native.state === "available") break
      await delay(25)
    } while (performance.now() < deadline)
    const laterImage = await stat(executable, { bigint: true })
    const duplicate = await transport.request(record, {
      ...createRequest(record.instanceId, "restart-wrapper"),
      nativeTarget: {
        device: laterImage.dev.toString(),
        inode: laterImage.ino.toString(),
        size: laterImage.size.toString(),
        modifiedNs: laterImage.mtimeNs.toString(),
      },
    })
    await handlers.get("session_shutdown")({}, ctx)
    const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))

    // Assert
    assert.equal(status.data.state, "restart-requested")
    assert.deepEqual(status.data.native, {
      runningVersion: "0.16.0",
      installedVersion: "0.17.0",
      state: "available",
    })
    assert.equal(
      notifications.some(
        ({ message, level }) =>
          message === "Installed native ompi 0.17.0 detected; run /ompi restart to apply." &&
          level === "info"
      ),
      true
    )
    assert.equal(shutdowns, 1)
    assert.equal(duplicate.data.operationId, status.data.operationId)
    assert.equal(manual.data.operationId, status.data.operationId)
    assert.equal(handoff.operationId, status.data.operationId)
    assert.equal(handoff.restartWrapper, true)
    assert.deepEqual(handoff.nativeTarget, {
      device: acceptedImage.dev.toString(),
      inode: acceptedImage.ino.toString(),
      size: acceptedImage.size.toString(),
      modifiedNs: acceptedImage.mtimeNs.toString(),
    })
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
