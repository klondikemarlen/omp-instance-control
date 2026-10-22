import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import { registerOmpiCommand } from "../../omp/command.js"
import { getScope } from "../../protocol/index.js"

const ENVIRONMENT_KEYS = [
  "HOME",
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_RUNTIME_DIR",
]

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "oc-"))
  const configRoot = path.join(root, "config")
  const cwd = path.join(root, "worktree")
  const runtimeRoot = path.join(root, "runtime")
  await Promise.all([mkdir(configRoot), mkdir(cwd), mkdir(runtimeRoot, { mode: 0o700 })])
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    HOME: root,
    PI_CONFIG_DIR: configRoot,
    PI_CODING_AGENT_DIR: path.join(configRoot, "agent"),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    XDG_RUNTIME_DIR: runtimeRoot,
  })
  const servers = []

  return {
    root,
    cwd,
    async addPeer(scope, instanceId, peerCwd = cwd) {
      const transport = await createTransport(scope)
      const record = {
        version: 1,
        instanceId,
        scope: scope.id,
        pid: process.pid,
        cwd: peerCwd,
        sessionId: `session-${instanceId.slice(0, 8)}`,
        sessionFile: null,
        launcherManaged: true,
        state: "running",
        operationId: null,
        lastRestart: null,
      }
      await transport.writeRecord(record)
      const requests = []
      const server = await transport.serve(instanceId, async (request) => {
        requests.push(request)
        if (request.action === "status") {
          return { data: { ...record, canRestart: true } }
        }
        return {
          data: {
            state: "accepted",
            operationId: request.requestId,
            message: "Restart accepted.",
          },
        }
      })
      servers.push({ server, transport, instanceId })
      return { record, requests }
    },
    async close() {
      await Promise.all(servers.map(({ server }) => server.close()))
      await Promise.all(
        servers.map(({ transport, instanceId }) => transport.removeRecord(instanceId))
      )
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

function createCommand(ctx, { runtime, cancelOnProgress = false, confirmTakeover } = {}) {
  const commands = new Map()
  const notifications = []
  const entries = []
  let terminalInput
  let cancelled = false
  const pi = {
    pi: createSdk(),
    appendEntry(customType, data) {
      entries.push({ customType, data })
    },
    registerCommand(name, command) {
      commands.set(name, command)
    },
  }
  registerOmpiCommand(pi, { getRuntime: () => runtime })
  ctx.ui = {
    theme: {
      fg(_color, text) {
        return text
      },
    },
    confirm: confirmTakeover,
    notify(message, level) {
      notifications.push({ message, level })
    },
    onTerminalInput(handler) {
      terminalInput = handler
      return () => {
        terminalInput = undefined
      }
    },
    setWidget(_key, content) {
      if (cancelOnProgress && content && !cancelled) {
        cancelled = true
        terminalInput("\u0003")
      }
    },
  }
  return { command: commands.get("ompi"), notifications }
}

function createContext(cwd) {
  return { agent: { kind: "main" }, mode: "tui", cwd, ui: undefined }
}
function createSdk() {
  return {
    KeybindingsManager: {
      inMemory(bindings) {
        return {
          matches(data, action) {
            return (
              action === "app.clear" &&
              bindings[action] === "ctrl+c" &&
              ["\u0003", "\u001b[99;5u"].includes(data)
            )
          },
        }
      },
    },
  }
}

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

test("when listing a selected profile, discovery uses its scope and ctx.cwd", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const defaultScope = getScope({ cwd: ctx.cwd })
    const workScope = getScope({ cwd: ctx.cwd, profile: "work" })
    const defaultId = "1".repeat(32)
    const workId = "2".repeat(32)
    const defaultPeer = await fixture.addPeer(
      defaultScope,
      defaultId,
      path.join(fixture.root, "default-peer")
    )
    await fixture.addPeer(workScope, workId, path.join(fixture.root, "work-peer"))
    const offlineId = "6".repeat(32)
    const defaultTransport = await createTransport(defaultScope)
    await defaultTransport.writeRecord({
      ...defaultPeer.record,
      instanceId: offlineId,
      sessionId: `session-${offlineId.slice(0, 8)}`,
    })
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler("instances", ctx)

    // Assert
    assert.deepEqual(
      ui.command
        .getArgumentCompletions("instances restart --instance 11111111")
        .map((item) => item.value),
      [`instances restart --instance ${defaultId}`]
    )
    assert.deepEqual(
      ui.command.getArgumentCompletions("instances rest").map((item) => item.value),
      ["instances restart"]
    )
    assert.ok(ui.command.getArgumentCompletions("res").some((item) => item.value === "restart"))
    assert.ok(
      ui.command
        .getArgumentCompletions("instances --p")
        .some((item) => item.value === "instances --profile")
    )
    assert.ok(
      ui.command
        .getArgumentCompletions("instances --profile work --j")
        .some((item) => item.value === "instances --profile work --json")
    )
    assert.deepEqual(
      ui.command
        .getArgumentCompletions("instances restart --instance 66666666")
        .map((item) => item.value),
      []
    )

    // Act
    await ui.command.handler("instances list --profile work --json", ctx)

    // Assert
    const workRows = JSON.parse(ui.notifications[1].message)
    assert.equal(workRows.length, 1)
    assert.equal(workRows[0].record.instanceId, workId)
    assert.equal(workRows[0].record.scope, workScope.id)
    assert.deepEqual(
      ui.command
        .getArgumentCompletions("instances restart --profile work --instance 22222222")
        .map((item) => item.value),
      [`instances restart --profile work --instance ${workId}`]
    )
    assert.deepEqual(
      ui.command
        .getArgumentCompletions("instances restart --instance 11111111")
        .map((item) => item.value),
      [`instances restart --instance ${defaultId}`]
    )
  } finally {
    await fixture.close()
  }
})

test("when completing a profile value, candidates stay within the active configuration root", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    process.env.OMP_PROFILE = "active"
    const profiles = path.join(fixture.root, "config", "profiles")
    await mkdir(path.join(profiles, "work"), { recursive: true })
    await mkdir(path.join(profiles, "invalid name"))
    await writeFile(path.join(profiles, "not-a-profile"), "")
    await mkdir(path.join(fixture.root, "other-config", "profiles", "private"), { recursive: true })
    const ctx = createContext(fixture.cwd)
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler("instances list", ctx)
    const candidates = ui.command.getArgumentCompletions("instances list --profile ")

    // Assert
    assert.deepEqual(
      candidates.map((item) => item.value),
      [
        "instances list --profile active",
        "instances list --profile default",
        "instances list --profile work",
      ]
    )
  } finally {
    await fixture.close()
  }
})

test("when a profile value is inline, completion preserves its command and option prefix", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    await mkdir(path.join(fixture.root, "config", "profiles", "work"), { recursive: true })
    const ctx = createContext(fixture.cwd)
    const ui = createCommand(ctx)
    await ui.command.handler("instances list", ctx)

    // Act
    const candidates = ui.command.getArgumentCompletions("instances restart --json --profile=wo")

    // Assert
    assert.deepEqual(
      candidates.map((item) => item.value),
      ["instances restart --json --profile=work"]
    )
  } finally {
    await fixture.close()
  }
})

test("when default listing uses an inline profile, completion fills the profile value", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    await mkdir(path.join(fixture.root, "config", "profiles", "work"), { recursive: true })
    const ctx = createContext(fixture.cwd)
    const ui = createCommand(ctx)
    await ui.command.handler("instances", ctx)

    // Act
    const candidates = ui.command.getArgumentCompletions("instances --profile=wo")

    // Assert
    assert.deepEqual(
      candidates.map((item) => item.value),
      ["instances --profile=work"]
    )
  } finally {
    await fixture.close()
  }
})

test("when no named profiles exist, completion still offers the active and default profiles", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    process.env.OMP_PROFILE = "active"
    const ctx = createContext(fixture.cwd)
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler("instances list", ctx)
    const candidates = ui.command.getArgumentCompletions("instances --profile ")

    // Assert
    assert.deepEqual(
      candidates.map((item) => item.value),
      ["instances --profile active", "instances --profile default"]
    )
  } finally {
    await fixture.close()
  }
})

test("when profile selection is empty or repeated, discovery uses the effective profile", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    process.env.OMP_PROFILE = "active"
    const activeScope = getScope({ cwd: ctx.cwd, profile: "active" })
    const activeId = "8".repeat(32)
    await fixture.addPeer(activeScope, activeId)
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler("instances list --profile= --json", ctx)

    // Assert
    const rows = JSON.parse(ui.notifications[0].message)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].record.instanceId, activeId)
    assert.equal(rows[0].record.scope, activeScope.id)
    assert.deepEqual(
      ui.command
        .getArgumentCompletions("instances restart --profile=work --profile= --instance 88888888")
        .map((item) => item.value),
      [`instances restart --profile=work --profile= --instance ${activeId}`]
    )
  } finally {
    await fixture.close()
  }
})

test("when restart selectors or list options conflict, the command rejects", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler("instances restart", ctx)
    await ui.command.handler("instances list --all=false", ctx)
    await ui.command.handler("instances list --no-wait=false", ctx)
    await ui.command.handler("instances restart --instance=", ctx)
    await ui.command.handler("list", ctx)
    await ui.command.handler("help", ctx)
    await ui.command.handler("version", ctx)
    await ui.command.handler("instances --profile work restart", ctx)

    // Assert
    assert.equal(ui.notifications.length, 8)
    assert.ok(ui.notifications.every((notification) => notification.level === "error"))
  } finally {
    await fixture.close()
  }
})

test("when all is explicitly false, the instance selector remains effective", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const scope = getScope({ cwd: ctx.cwd })
    const peerId = "9".repeat(32)
    const peer = await fixture.addPeer(scope, peerId)
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler(
      `instances restart --all=false --instance ${peerId} --no-wait --json`,
      ctx
    )

    // Assert
    const rows = JSON.parse(ui.notifications[0].message)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].instanceId, peerId)
    assert.equal(rows[0].status, "accepted")
    assert.equal(peer.requests.filter((request) => request.action === "restart").length, 1)
  } finally {
    await fixture.close()
  }
})

test("when a broadcast selects this session, restart returns pending without observation", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const scope = getScope({ cwd: ctx.cwd })
    const selfId = "3".repeat(32)
    const peerId = "4".repeat(32)
    const self = await fixture.addPeer(scope, selfId)
    const peer = await fixture.addPeer(scope, peerId)
    const ui = createCommand(ctx, {
      runtime: { instanceId: selfId, launch: { scope } },
    })

    // Act
    await ui.command.handler("instances restart --all --json", ctx)

    // Assert
    const rows = JSON.parse(ui.notifications[0].message)
    assert.deepEqual(
      rows.map((row) => [row.instanceId, row.status]).sort(),
      [
        [selfId, "accepted"],
        [peerId, "accepted"],
      ].sort()
    )
    assert.equal(self.requests.filter((request) => request.action === "restart").length, 1)
    assert.equal(peer.requests.filter((request) => request.action === "restart").length, 1)
  } finally {
    await fixture.close()
  }
})

test("when /ompi restart runs in a managed session, it targets only that instance without waiting", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const defaultScope = getScope({ cwd: ctx.cwd })
    const managedScope = getScope({ cwd: ctx.cwd, profile: "work" })
    const selfId = "a".repeat(32)
    const peerId = "b".repeat(32)
    const self = await fixture.addPeer(managedScope, selfId)
    const peer = await fixture.addPeer(defaultScope, peerId)
    const runtime = {
      instanceId: selfId,
      launch: { scope: managedScope, canRestartWrapper: true },
      transport: await createTransport(managedScope),
    }
    const { command, notifications } = createCommand(ctx, { runtime })

    // Act
    await command.handler("restart", ctx)

    // Assert
    assert.equal(self.requests.length, 1)
    assert.equal(self.requests[0].action, "restart-wrapper")
    assert.equal(self.requests[0].instanceId, selfId)
    assert.deepEqual(peer.requests, [])
    assert.equal(notifications[0].level, "info")
  } finally {
    await fixture.close()
  }
})

test("when /ompi restart is unwrapped or uses an old launcher, it refuses without shutdown", async () => {
  // Arrange
  const ctx = createContext(process.cwd())
  let shutdowns = 0
  ctx.shutdown = () => {
    shutdowns += 1
  }
  const unwrapped = createCommand(ctx)
  // Act
  await unwrapped.command.handler("restart", ctx)

  const oldLauncher = createCommand(ctx, {
    runtime: {
      instanceId: "c".repeat(32),
      launch: {},
      transport: {
        readRecords() {
          assert.fail("must refuse before resolving or requesting a target")
        },
      },
    },
  })
  await oldLauncher.command.handler("restart", ctx)

  // Assert
  assert.equal(shutdowns, 0)
  assert.equal(unwrapped.notifications[0].level, "error")
  assert.equal(oldLauncher.notifications[0].level, "error")
})

test("when Ctrl-C cancels peer observation, accepted restart remains pending", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const scope = getScope({ cwd: ctx.cwd })
    const peerId = "5".repeat(32)
    const peer = await fixture.addPeer(scope, peerId)
    const ui = createCommand(ctx, { cancelOnProgress: true })

    // Act
    await ui.command.handler(`instances restart --instance ${peerId} --json`, ctx)

    // Assert
    const rows = JSON.parse(ui.notifications[0].message)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].instanceId, peerId)
    assert.equal(rows[0].status, "waiting")
    assert.equal(peer.requests.filter((request) => request.action === "restart").length, 1)
  } finally {
    await fixture.close()
  }
})

test("when separate entry URLs bind one host, one endpoint and self-safe command are registered", async () => {
  // Arrange
  const fixture = await createFixture()
  const launchDirectory = path.join(fixture.root, "launch")
  const launchToken = "7".repeat(32)
  const sessionFile = path.join(fixture.root, "session.jsonl")
  await mkdir(launchDirectory, { mode: 0o700 })
  await writeFile(sessionFile, "persisted session", { mode: 0o600 })
  const scope = getScope({ cwd: fixture.cwd })
  const entryPath = fileURLToPath(new URL("../../omp/index.js", import.meta.url))
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token: launchToken,
    pid: process.ppid,
    scope,
    extensionPath: entryPath,
    lastRestart: null,
    builtinFlags: [],
  })
  const launchEnvironment = {
    OMP_INSTANCE_CONTROL_LAUNCH_DIR: launchDirectory,
    OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: launchToken,
  }
  const previousLaunchEnvironment = Object.fromEntries(
    Object.keys(launchEnvironment).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, launchEnvironment)

  const events = createEventBus()
  const handlers = new Map()
  const commands = []
  function createExtensionApi() {
    return {
      events,
      pi: createSdk(),
      runtime: { flagValues: new Map() },
      on(event, handler) {
        const eventHandlers = handlers.get(event) ?? []
        eventHandlers.push(handler)
        handlers.set(event, eventHandlers)
      },
      registerCommand(name, command) {
        commands.push({ name, command })
      },
    }
  }

  const ctx = createContext(fixture.cwd)
  const notifications = []
  let shutdownRequests = 0
  const shutdownRequested = Promise.withResolvers()
  ctx.sessionManager = {
    getSessionId: () => "persisted-session",
    getSessionFile: () => sessionFile,
  }
  ctx.shutdown = () => {
    shutdownRequests += 1
    shutdownRequested.resolve()
  }
  ctx.ui = {
    setStatus() {},
    notify(message, level) {
      notifications.push({ message, level })
    },
  }
  const firstEntryUrl = new URL("../../omp/index.js", import.meta.url)
  firstEntryUrl.searchParams.set("entry", "first")
  const secondEntryUrl = new URL("../../omp/index.js", import.meta.url)
  secondEntryUrl.searchParams.set("entry", "second")

  try {
    const firstEntry = (await import(firstEntryUrl.href)).default
    const secondEntry = (await import(secondEntryUrl.href)).default
    const firstApi = createExtensionApi()
    const secondApi = createExtensionApi()

    // Act
    await firstEntry(firstApi)
    await secondEntry(secondApi)
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({}, ctx)
    }

    // Assert
    const transport = await createTransport(scope)
    const records = await transport.readRecords()
    assert.equal(records.length, 1)
    assert.equal(commands.filter((command) => command.name === "ompi").length, 1)

    await commands[0].command.handler(
      `instances restart --instance ${records[0].instanceId} --json`,
      ctx
    )
    await shutdownRequested.promise
    const outcomes = JSON.parse(notifications[0].message)
    assert.equal(outcomes[0].status, "accepted")
    assert.equal(shutdownRequests, 1)
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({}, ctx)
    }
    for (const [key, value] of Object.entries(previousLaunchEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fixture.close()
  }
})

test("when take-over receives instance-control options, the session stays running", async () => {
  // Arrange
  const ctx = createContext(process.cwd())
  let shutdownRequested = false
  ctx.shutdown = () => {
    shutdownRequested = true
  }
  const { command, notifications } = createCommand(ctx)

  // Act
  await command.handler("take-over --profile work", ctx)

  // Assert
  assert.equal(shutdownRequested, false)
  assert.equal(notifications[0].level, "error")
})

test("when take-over targets an already managed session, it stays running", async () => {
  // Arrange
  const ctx = createContext(process.cwd())
  let shutdownRequested = false
  ctx.shutdown = () => {
    shutdownRequested = true
  }
  const { command, notifications } = createCommand(ctx, { runtime: {} })

  // Act
  await command.handler("take-over", ctx)

  // Assert
  assert.equal(shutdownRequested, false)
  assert.equal(notifications[0].level, "error")
})

test("when take-over targets an unpersisted session, it stays running", async () => {
  // Arrange
  const ctx = createContext(process.cwd())
  ctx.sessionManager = {
    getSessionId: () => "unpersisted-session",
    getSessionFile: () => undefined,
  }
  let shutdownRequested = false
  ctx.shutdown = () => {
    shutdownRequested = true
  }
  const { command, notifications } = createCommand(ctx)

  // Act
  await command.handler("take-over", ctx)

  // Assert
  assert.equal(shutdownRequested, false)
  assert.equal(notifications[0].level, "error")
})

test("when the take-over dialog is cancelled, the session stays running", async () => {
  // Arrange
  const fixture = await createFixture()
  const executable = path.join(fixture.root, "ompi")
  const sessionFile = path.join(fixture.root, "session.jsonl")
  await writeFile(executable, "#!/bin/sh\nexit 0\n")
  await chmod(executable, 0o755)
  await writeFile(sessionFile, "persisted session\n")
  const previousPath = process.env.PATH
  process.env.PATH = fixture.root
  const ctx = createContext(fixture.cwd)
  ctx.sessionManager = {
    getSessionId: () => "persisted-session",
    getSessionFile: () => sessionFile,
  }
  let shutdownRequested = false
  ctx.shutdown = () => {
    shutdownRequested = true
  }
  const { command, notifications } = createCommand(ctx, { confirmTakeover: async () => false })

  try {
    // Act
    await command.handler("take-over", ctx)

    // Assert
    assert.equal(shutdownRequested, false)
    assert.deepEqual(notifications, [])
  } finally {
    process.env.PATH = previousPath
    await fixture.close()
  }
})

test("when the session switches during take-over confirmation, shutdown is refused", async () => {
  // Arrange
  const fixture = await createFixture()
  const executable = path.join(fixture.root, "ompi")
  const sessionFile = path.join(fixture.root, "session.jsonl")
  const switchedFile = path.join(fixture.root, "switched.jsonl")
  await writeFile(executable, "#!/bin/sh\nexit 0\n")
  await chmod(executable, 0o755)
  await writeFile(sessionFile, "persisted session\n")
  await writeFile(switchedFile, "switched session\n")
  const previousPath = process.env.PATH
  process.env.PATH = fixture.root
  let currentFile = sessionFile
  const ctx = createContext(fixture.cwd)
  ctx.sessionManager = {
    getSessionId: () => "persisted-session",
    getSessionFile: () => currentFile,
  }
  let shutdownRequested = false
  ctx.shutdown = () => {
    shutdownRequested = true
  }
  const { command, notifications } = createCommand(ctx, {
    confirmTakeover: async () => {
      currentFile = switchedFile
      return true
    },
  })

  try {
    // Act
    await command.handler("take-over", ctx)

    // Assert
    assert.equal(shutdownRequested, false)
    assert.equal(notifications[0].level, "error")
  } finally {
    process.env.PATH = previousPath
    await fixture.close()
  }
})

test("when cleanup is requested with JSON, ompi reports and removes a confirmed stale record", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const scope = getScope({ cwd: ctx.cwd })
    const instanceId = "d".repeat(32)
    const transport = await createTransport(scope)
    await transport.writeRecord({
      version: 1,
      instanceId,
      scope: scope.id,
      pid: spawnSync("/usr/bin/true").pid,
      cwd: fixture.cwd,
      sessionId: "stale-session",
      sessionFile: null,
      launcherManaged: true,
      state: "running",
      lastRestart: null,
    })
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler("instances cleanup --json", ctx)

    // Assert
    assert.equal(ui.notifications[0].level, "info")
    assert.deepEqual(
      JSON.parse(ui.notifications[0].message).map(({ instanceId, status }) => ({
        instanceId,
        status,
      })),
      [{ instanceId, status: "removed" }]
    )
    await ui.command.handler("instances cleanup --json", ctx)
    assert.equal(ui.notifications[1].message, "[]")
  } finally {
    await fixture.close()
  }
})

test("when completing cleanup, ompi offers only cleanup options and profile values", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const ui = createCommand(ctx)

    // Act
    const options = ui.command
      .getArgumentCompletions("instances cleanup ")
      .map(({ value }) => value)
    const profiles = ui.command
      .getArgumentCompletions("instances cleanup --profile ")
      .map(({ value }) => value)

    // Assert
    assert.deepEqual(options, [
      "instances cleanup --profile",
      "instances cleanup --json",
      "instances cleanup --help",
      "instances cleanup -h",
      "instances cleanup --version",
    ])
    assert.deepEqual(profiles, ["instances cleanup --profile default"])
  } finally {
    await fixture.close()
  }
})

test("when cleanup receives restart-only options, ompi rejects without cleaning records", async () => {
  // Arrange
  const fixture = await createFixture()
  try {
    const ctx = createContext(fixture.cwd)
    const scope = getScope({ cwd: ctx.cwd })
    const instanceId = "e".repeat(32)
    const transport = await createTransport(scope)
    await transport.writeRecord({
      version: 1,
      instanceId,
      scope: scope.id,
      pid: spawnSync("/usr/bin/true").pid,
      cwd: fixture.cwd,
      sessionId: "stale-session",
      sessionFile: null,
      launcherManaged: true,
      state: "running",
      lastRestart: null,
    })
    const ui = createCommand(ctx)

    // Act
    await ui.command.handler("instances cleanup --all", ctx)

    // Assert
    assert.equal(ui.notifications[0].level, "error")
    assert.equal((await transport.readRecords()).length, 1)
  } finally {
    await fixture.close()
  }
})
