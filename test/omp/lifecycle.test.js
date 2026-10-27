import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import { createRequest, getScope } from "../../protocol/index.js"

import instanceControl from "../../omp/index.js"

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
    VERSION: "18.13.2",
    z: {
      object(properties) {
        return properties
      },
      string() {
        const schema = {}
        schema.optional = () => schema
        return schema
      },
      boolean() {
        return {}
      },
    },
    KeybindingsManager: {
      inMemory() {
        return { matches: () => false }
      },
    },
  }
}

function createExtensionApi(
  events,
  handlers,
  ctx,
  { branch = [], deliverMessage, includeBranch = true } = {}
) {
  const tools = new Map()
  const preparationRequested = Promise.withResolvers()
  const messages = []
  if (includeBranch) {
    ctx.sessionManager.getBranch = () => branch
  }

  return {
    api: {
      events,
      pi: createSdk(),
      runtime: { flagValues: new Map() },
      registerTool(tool) {
        tools.set(tool.name, tool)
      },
      appendEntry(customType, data) {
        const entry = { type: "custom", customType, data }
        branch.push(entry)
        appendFileSync(ctx.sessionManager.getSessionFile(), `${JSON.stringify(entry)}\n`)
      },
      sendUserMessage(content, options) {
        messages.push({ content, options })
        preparationRequested.resolve()
        return deliverMessage?.(content, options)
      },
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    },
    branch,
    messages,
    preparationRequested: preparationRequested.promise,
    tools,
  }
}

async function waitForPreparation(extension) {
  await Promise.race([
    extension.preparationRequested,
    delay(2_000).then(() => {
      throw new Error("The cooperative preparation message was not delivered.")
    }),
  ])
}

async function createResumeFixture({
  operationId = "restart-operation",
  previousInstanceId = "previous-instance",
  checkpoint = {},
  priorContinuations = [],
  deliverMessage,
  includeBranch = true,
  hostVersion = "18.13.2",
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-resume-"))
  const launchDirectory = path.join(root, "launch")
  const sessionFile = path.join(root, "resumed-session.jsonl")
  const sessionId = "resumed-session"
  const token = "9".repeat(32)
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
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, environment)
  const scope = getScope({ env: environment, cwd: root })
  await mkdir(launchDirectory, { mode: 0o700 })
  const savedCheckpoint = {
    entryId: "saved-checkpoint",
    kind: "checkpoint",
    operationId,
    previousInstanceId,
    instanceId: previousInstanceId,
    sessionId,
    sessionFile,
    cwd: root,
    scopeId: scope.id,
    requestedAt: 1_000,
    checkpointAt: 1_001,
    ready: true,
    checkpoint: "Completed: prepare the result. Remaining: finish the verification.",
    ...checkpoint,
  }
  const entries = [
    savedCheckpoint,
    ...priorContinuations.map((entry, index) => ({
      entryId: `prior-continuation-${index}`,
      kind: "continuation",
      operationId,
      previousInstanceId,
      sessionId,
      sessionFile,
      cwd: root,
      scopeId: scope.id,
      ...entry,
    })),
  ]
  const transcript = [
    { type: "session", id: sessionId },
    ...entries.map((data) => ({
      type: "custom",
      customType: "ompi-cooperative-restart",
      data,
    })),
  ]
  await writeFile(sessionFile, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    mode: 0o600,
  })
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    lastRestart: { operationId, previousInstanceId },
    builtinFlags: [],
  })

  const handlers = new Map()
  const sessionContext = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus() {},
      notify() {},
    },
    shutdown() {},
  }
  const extension = createExtensionApi(createEventBus(), handlers, sessionContext, {
    branch: transcript.slice(1),
    deliverMessage,
    includeBranch,
  })
  extension.api.pi.VERSION = hostVersion

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await handlers.get("session_shutdown")?.({}, sessionContext)
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  }

  try {
    await instanceControl(extension.api)
    await handlers.get("session_start")({}, sessionContext)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    return { close, ctx: sessionContext, extension, handlers, record, transport }
  } catch (error) {
    await close()
    throw error
  }
}

async function reportReadyCheckpoint(extension, operationId, ctx) {
  return extension.tools.get("ompi_restart_checkpoint").execute(
    "checkpoint-call",
    {
      operationId,
      checkpoint:
        "Completed: no work has been committed yet. Remaining: continue the accepted task after restart.",
      ready: true,
    },
    undefined,
    undefined,
    ctx
  )
}

async function reportBlockedCheckpoint(extension, operationId, ctx, blocker) {
  return extension.tools.get("ompi_restart_checkpoint").execute(
    "checkpoint-call",
    {
      operationId,
      checkpoint: "Completed: current work is recorded. Remaining: wait for the output-owning job.",
      ready: false,
      blocker,
    },
    undefined,
    undefined,
    ctx
  )
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

test("when restart arrives before the first saved response, it waits for a persisted checkpoint and coalesces requests", async () => {
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
    await waitForPreparation(extension)
    const duplicate = await transport.request(record, createRequest(record.instanceId, "restart"))
    const pending = await transport.request(record, createRequest(record.instanceId, "status"))
    events.emit("omp-exit-command:exit-requested", { sessionId: "" })
    events.emit("omp-exit-command:exit-requested", { sessionId: "other-session" })
    const shutdownsBeforePersistence = shutdowns
    await writeFile(sessionFile, '{"type":"session","id":"first-session"}\n', { mode: 0o600 })
    await handlers.get("agent_end")({}, ctx)
    const shutdownsAfterPersistence = shutdowns
    ctx.cwd = path.join(root, "different-working-directory")
    const wrongContextResult = await reportReadyCheckpoint(extension, request.requestId, ctx)
    const shutdownsAfterContextChange = shutdowns
    ctx.cwd = root
    const blockedResult = await reportBlockedCheckpoint(
      extension,
      request.requestId,
      ctx,
      "A background job still owns the output file."
    )
    const blockedStatus = await transport.request(
      record,
      createRequest(record.instanceId, "status")
    )
    const shutdownsAfterBlock = shutdowns
    const checkpointResult = await reportReadyCheckpoint(extension, request.requestId, ctx)
    const shutdownsAfterCheckpoint = shutdowns
    await handlers.get("session_shutdown")({}, ctx)
    const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))

    // Assert
    assert.equal(accepted.ok, true)
    assert.equal(accepted.data.operationId, request.requestId)
    assert.equal(duplicate.data.operationId, request.requestId)
    assert.equal(pending.data.state, "restart-requested")
    assert.equal(pending.data.canRestart, false)
    assert.equal(shutdownsBeforePersistence, 0)
    assert.equal(shutdownsAfterPersistence, 0)
    assert.equal(shutdownsAfterContextChange, 0)
    assert.equal(wrongContextResult.isError, true)
    assert.equal(shutdownsAfterBlock, 0)
    assert.equal(blockedStatus.data.cooperative.operationId, request.requestId)
    assert.equal(blockedStatus.data.cooperative.phase, "blocked")
    assert.equal(blockedStatus.data.cooperative.message.includes("output file"), true)
    assert.equal(blockedResult.content[0].text.includes("no shutdown was requested"), true)
    assert.deepEqual(
      extension.branch
        .filter((entry) => entry.data?.kind === "checkpoint")
        .map((entry) => entry.data.ready),
      [false, true]
    )
    assert.equal(shutdownsAfterCheckpoint, 1)
    assert.equal(shutdowns, 1)
    assert.equal(extension.messages.length, 1)
    assert.equal(extension.messages[0].options.deliverAs, "aside")
    assert.equal(extension.messages[0].content.includes("ompi_restart_checkpoint"), true)
    assert.equal(
      checkpointResult.content[0].text.includes("does not confirm that settlement"),
      true
    )
    assert.equal(handoff.operationId, request.requestId)
    assert.equal(handoff.restartWrapper, undefined)
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
    await waitForPreparation(extension)
    await reportReadyCheckpoint(extension, request.requestId, ctx)
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

test("when an installed update joins a pending manual restart, coalescing retains its verified image", async () => {
  // Arrange
  const root = await mkdtemp(path.join(tmpdir(), "ic-auto-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "4".repeat(32)
  const executable = path.join(root, "ompi")
  await writeFile(executable, "#!/bin/sh\nprintf 'ompi 0.16.0\\n'\n", { mode: 0o700 })
  const image = await stat(executable, { bigint: true })
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
      device: image.dev.toString(),
      inode: image.ino.toString(),
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
      notify() {},
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
    const replacement = `${executable}.new`
    await writeFile(replacement, "#!/bin/sh\nprintf 'ompi 0.17.0\\n'\n", { mode: 0o700 })

    // Act
    const manual = await transport.request(
      record,
      createRequest(record.instanceId, "restart-wrapper")
    )
    await waitForPreparation(extension)
    await rename(replacement, executable)
    const installed = await stat(executable, { bigint: true })
    const deadline = performance.now() + 10_000
    let status
    do {
      status = await transport.request(record, createRequest(record.instanceId, "status"))
      if (status.data.native.state === "pending") break
      await delay(25)
    } while (performance.now() < deadline)
    const beforePersistence = shutdowns
    const duplicate = await transport.request(
      record,
      createRequest(record.instanceId, "restart-wrapper")
    )
    const beforeCheckpoint = shutdowns
    await reportReadyCheckpoint(extension, manual.data.operationId, ctx)
    const afterCheckpoint = shutdowns
    await handlers.get("agent_end")({}, ctx)
    await handlers.get("session_shutdown")({}, ctx)
    const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))

    // Assert
    assert.equal(status.data.state, "restart-requested")
    assert.deepEqual(status.data.native, {
      runningVersion: "0.16.0",
      installedVersion: "0.17.0",
      state: "pending",
    })
    assert.equal(beforePersistence, 0)
    assert.equal(beforeCheckpoint, 0)
    assert.equal(afterCheckpoint, 1)
    assert.equal(shutdowns, 1)
    assert.equal(duplicate.data.operationId, status.data.operationId)
    assert.equal(manual.data.operationId, status.data.operationId)
    assert.equal(handoff.operationId, status.data.operationId)
    assert.equal(handoff.restartWrapper, true)
    assert.deepEqual(handoff.nativeTarget, {
      device: installed.dev.toString(),
      inode: installed.ino.toString(),
      size: installed.size.toString(),
      modifiedNs: installed.mtimeNs.toString(),
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

test("when a resumed session matches a ready checkpoint, it submits one correlated continuation", async () => {
  // Arrange
  const fixture = await createResumeFixture()

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )
    await fixture.handlers.get("session_start")({}, fixture.ctx)

    // Assert
    assert.equal(fixture.extension.messages.length, 1)
    assert.equal(fixture.extension.messages[0].options.deliverAs, "aside")
    assert.equal(
      fixture.extension.messages[0].content.includes("Completed: prepare the result."),
      true
    )
    assert.equal(
      fixture.extension.messages[0].content.includes("Remaining: finish the verification."),
      true
    )
    assert.equal(status.data.cooperative.operationId, "restart-operation")
    assert.equal(status.data.cooperative.phase, "resumed")
    assert.equal(Number.isSafeInteger(status.data.cooperative.resumedAt), true)
    assert.deepEqual(
      fixture.extension.branch
        .filter((entry) => entry.data?.kind === "continuation")
        .map((entry) => entry.data.stage),
      ["attempted", "submitted"]
    )
    assert.equal(fixture.extension.messages.length, 1)
  } finally {
    await fixture.close()
  }
})

test("when an earlier continuation attempt is ambiguous, a replacement does not send it again", async () => {
  // Arrange
  const fixture = await createResumeFixture({
    priorContinuations: [
      {
        stage: "attempted",
        replacementInstanceId: "crashed-replacement",
        attemptedAt: 1_002,
      },
    ],
  })

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(fixture.extension.messages.length, 0)
    assert.equal(status.data.cooperative.operationId, "restart-operation")
    assert.equal(status.data.cooperative.phase, "blocked")
    assert.equal(status.data.cooperative.message.includes("admission is ambiguous"), true)
  } finally {
    await fixture.close()
  }
})

test("when continuation delivery throws, the replacement publishes a blocked outcome", async () => {
  // Arrange
  const fixture = await createResumeFixture({
    deliverMessage() {
      throw new Error("host refused continuation")
    },
  })

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(fixture.extension.messages.length, 1)
    assert.equal(status.data.cooperative.operationId, "restart-operation")
    assert.equal(status.data.cooperative.phase, "blocked")
    assert.equal(status.data.cooperative.message.includes("host refused continuation"), true)
    assert.deepEqual(
      fixture.extension.branch
        .filter((entry) => entry.data?.kind === "continuation")
        .map((entry) => entry.data.stage),
      ["attempted", "failed"]
    )
  } finally {
    await fixture.close()
  }
})

test("when the saved checkpoint reports a blocker, replacement startup does not continue work", async () => {
  // Arrange
  const fixture = await createResumeFixture({
    checkpoint: {
      ready: false,
      blocker: "A background command still owns the output file.",
    },
  })

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(fixture.extension.messages.length, 0)
    assert.equal(status.data.cooperative.phase, "blocked")
    assert.equal(status.data.cooperative.message.includes("background command"), true)
  } finally {
    await fixture.close()
  }
})

test("when a saved checkpoint belongs to another launch scope, replacement does not deliver it", async () => {
  // Arrange
  const fixture = await createResumeFixture({
    checkpoint: { scopeId: "another-launch-scope" },
  })

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(fixture.extension.messages.length, 0)
    assert.equal(status.data.cooperative.phase, "blocked")
    assert.equal(status.data.cooperative.message.includes("does not match"), true)
  } finally {
    await fixture.close()
  }
})

test("when the transcript records a submitted continuation, a replacement recognizes it without resending", async () => {
  // Arrange
  const fixture = await createResumeFixture({
    priorContinuations: [
      {
        stage: "submitted",
        replacementInstanceId: "earlier-replacement",
        submittedAt: 1_002,
      },
    ],
  })

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(fixture.extension.messages.length, 0)
    assert.equal(status.data.cooperative.operationId, "restart-operation")
    assert.equal(status.data.cooperative.phase, "resumed")
    assert.equal(status.data.cooperative.resumedAt, 1_002)
  } finally {
    await fixture.close()
  }
})

test("when the public session branch API is unavailable, replacement reports blocked continuation", async () => {
  // Arrange
  const fixture = await createResumeFixture({ includeBranch: false })

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )
    const rejectedRestart = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )

    // Assert
    assert.equal(fixture.extension.messages.length, 0)
    assert.equal(status.data.cooperative.phase, "blocked")
    assert.equal(
      status.data.cooperative.message.includes("session branch API is unavailable"),
      true
    )
    assert.equal(rejectedRestart.ok, false)
    assert.equal(rejectedRestart.error.code, "COOPERATIVE_RESTART_UNAVAILABLE")
  } finally {
    await fixture.close()
  }
})

test("when a ready checkpoint leaves the active branch before teardown, no restart handoff is written", async () => {
  // Arrange
  const fixture = await createResumeFixture()
  const request = createRequest(fixture.record.instanceId, "restart")

  try {
    // Act
    await fixture.transport.request(fixture.record, request)
    await reportReadyCheckpoint(fixture.extension, request.requestId, fixture.ctx)
    const checkpointIndex = fixture.extension.branch.findIndex(
      (entry) => entry.data?.kind === "checkpoint" && entry.data.operationId === request.requestId
    )
    fixture.extension.branch.splice(checkpointIndex, 1)
    await fixture.handlers.get("session_shutdown")({}, fixture.ctx)

    // Assert
    assert.equal(checkpointIndex >= 0, true)
    await assert.rejects(
      readFile(path.join(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR, "handoff.json")),
      { code: "ENOENT" }
    )
  } finally {
    await fixture.close()
  }
})

test("when the host predates non-interrupting aside support, restart refuses without sending prompts", async () => {
  // Arrange
  const fixture = await createResumeFixture({ hostVersion: "18.13.1" })

  try {
    // Act
    const response = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(response.ok, false)
    assert.equal(response.error.code, "COOPERATIVE_RESTART_UNAVAILABLE")
    assert.equal(status.data.canRestart, false)
    assert.equal(status.data.cooperative.phase, "blocked")
    assert.match(status.data.cooperative.message, /18\.13\.2/)
    assert.deepEqual(fixture.extension.messages, [])
  } finally {
    await fixture.close()
  }
})

test("when OMP settlement exceeds the target, status identifies running work without forcing or cancelling restart", async (t) => {
  // Arrange
  const fixture = await createResumeFixture()
  fixture.ctx.getAsyncJobSnapshot = () => ({ running: [{ type: "bash" }], delivery: { queued: 0 } })
  const request = createRequest(fixture.record.instanceId, "restart")
  t.mock.timers.enable({ apis: ["setTimeout"] })

  try {
    // Act
    await fixture.transport.request(fixture.record, request)
    await reportReadyCheckpoint(fixture.extension, request.requestId, fixture.ctx)
    t.mock.timers.tick(60_001)
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )
    await fixture.handlers.get("session_shutdown")({}, fixture.ctx)
    const handoff = JSON.parse(
      await readFile(path.join(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR, "handoff.json"), "utf8")
    )

    // Assert
    assert.equal(status.data.cooperative.phase, "restarting")
    assert.match(status.data.cooperative.message, /1 running OMP async job.*bash/)
    assert.match(status.data.cooperative.message, /No shutdown was forced/)
    assert.equal(handoff.operationId, request.requestId)
  } finally {
    t.mock.timers.reset()
    await fixture.close()
  }
})
