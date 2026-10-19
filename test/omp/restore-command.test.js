import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { createTransport } from "../../linux/transport.js"
import { listSavedSessions, saveRestoreName, writeRestoreSnapshot } from "../../linux/restore.js"
import { registerOmpiCommand } from "../../omp/command.js"
import { getScope } from "../../protocol/index.js"

const ENVIRONMENT_KEYS = [
  "HOME",
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_RUNTIME_DIR",
  "PATH",
]

async function createFixture({ relativeAgentDirectory = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-rc-"))
  const configRoot = path.join(root, "config")
  const cwd = path.join(root, "worktree")
  const runtimeRoot = path.join(root, "runtime")
  const binDirectory = path.join(root, "bin")
  await Promise.all([
    mkdir(configRoot, { mode: 0o700 }),
    mkdir(cwd),
    mkdir(runtimeRoot, { mode: 0o700 }),
    mkdir(binDirectory),
  ])
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  const agentDirectory = path.join(configRoot, "agent")
  Object.assign(process.env, {
    HOME: root,
    PI_CONFIG_DIR: configRoot,
    PI_CODING_AGENT_DIR: relativeAgentDirectory
      ? path.relative(process.cwd(), agentDirectory)
      : agentDirectory,
    OMP_PROFILE: "",
    PI_PROFILE: "",
    XDG_RUNTIME_DIR: runtimeRoot,
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  })
  const scope = getScope({
    cwd: relativeAgentDirectory ? process.cwd() : cwd,
  })
  const sessionFile = path.join(root, "session.jsonl")
  await writeFile(sessionFile, "persisted session\n", { mode: 0o600 })
  const restoreId = "a".repeat(32)
  const instanceId = "b".repeat(32)
  const snapshot = {
    version: 1,
    restoreId,
    scope: {
      id: scope.id,
      configRoot: scope.configRoot,
      profile: scope.profile,
      agentDir: scope.agentDir,
    },
    sessionFile,
    sessionId: "persisted-session",
    cwd,
    resumeArgs: ["--model", "default"],
    owner: {
      bootId: "00000000-0000-0000-0000-000000000000",
      pid: 999999,
      startTime: "1",
    },
    agentOwner: {
      bootId: "00000000-0000-0000-0000-000000000000",
      pid: 999998,
      startTime: "1",
    },
    updatedAt: new Date().toISOString(),
  }
  const ompiExecutable = path.join(binDirectory, "ompi")
  await writeFile(ompiExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  await chmod(ompiExecutable, 0o700)
  const transport = await createTransport(scope)
  const servers = []

  return {
    root,
    cwd,
    scope,
    snapshot,
    restoreId,
    instanceId,
    transport,
    async addManagedPeer() {
      await writeRestoreSnapshot(scope, snapshot)
      const record = {
        version: 1,
        instanceId,
        scope: scope.id,
        pid: process.pid,
        cwd,
        sessionId: snapshot.sessionId,
        sessionFile,
        launcherManaged: true,
        state: "running",
        operationId: null,
        lastRestart: null,
        restoreId,
      }
      await transport.writeRecord(record)
      const server = await transport.serve(instanceId, async (request) => {
        if (request.action === "status") {
          return { data: { ...record, canRestart: true } }
        }
        throw new Error(`Unexpected request action: ${request.action}`)
      })
      servers.push(server)
    },
    async saveName(name = "work") {
      await writeRestoreSnapshot(scope, snapshot)
      await saveRestoreName(scope, name, restoreId)
    },
    async close() {
      await Promise.all(servers.map((server) => server.close()))
      await Promise.all(servers.map(() => transport.removeRecord(instanceId)))
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

function createContext(cwd, { select, confirm } = {}) {
  const notifications = []
  const entries = []
  let shutdowns = 0
  let selectCalls = 0
  let confirmCalls = 0
  return {
    ctx: {
      agent: { kind: "main" },
      mode: "tui",
      cwd,
      ui: {
        notify(message, level) {
          notifications.push({ message, level })
        },
        async select(...args) {
          selectCalls += 1
          return select?.(...args)
        },
        async confirm(...args) {
          confirmCalls += 1
          return confirm?.(...args)
        },
      },
      shutdown() {
        shutdowns += 1
      },
    },
    notifications,
    entries,
    get shutdowns() {
      return shutdowns
    },
    get selectCalls() {
      return selectCalls
    },
    get confirmCalls() {
      return confirmCalls
    },
  }
}

function registerCommand(runtime = undefined, entries = []) {
  const commands = new Map()
  const pi = {
    pi: {
      KeybindingsManager: {
        inMemory() {
          return { matches: () => false }
        },
      },
    },
    registerCommand(name, command) {
      commands.set(name, command)
    },
    appendEntry(customType, data) {
      entries.push({ customType, data })
    },
  }
  registerOmpiCommand(pi, { getRuntime: () => runtime })
  return commands.get("ompi")
}

test("when saving a live managed instance, the exact binding is listed and completed", async () => {
  const fixture = await createFixture()
  try {
    await fixture.addManagedPeer()
    const context = createContext(fixture.cwd)
    const command = registerCommand(undefined, context.entries)

    await command.handler(`restore save work --instance ${fixture.instanceId}`, context.ctx)

    const completed = command.getArgumentCompletions("restore ")
    assert.ok(completed.some((item) => item.value === "restore work"))
    const saved = await listSavedSessions(fixture.scope)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, "work")
    assert.equal(saved[0].session.sessionFile, fixture.snapshot.sessionFile)
    assert.equal(saved[0].session.sessionId, fixture.snapshot.sessionId)

    await command.handler(`restore save work --instance ${fixture.instanceId}`, context.ctx)
    assert.ok(
      context.notifications.some(({ message, level }) => {
        return level === "error" && message.includes("cannot be overwritten")
      })
    )
    await command.handler("restore --list --json", context.ctx)
    assert.ok(context.notifications.some(({ message }) => message.includes('"name":"work"')))
    assert.equal((await listSavedSessions(fixture.scope)).length, 1)
  } finally {
    await fixture.close()
  }
})

test("when restore selection is cancelled or confirmation is declined, OMP stays running", async () => {
  const fixture = await createFixture()
  try {
    await fixture.saveName()
    const context = createContext(fixture.cwd, {
      select: async () => undefined,
      confirm: async () => false,
    })
    const command = registerCommand(undefined, context.entries)

    await command.handler("restore", context.ctx)
    assert.equal(context.selectCalls, 1)
    assert.equal(context.confirmCalls, 0)
    assert.equal(context.shutdowns, 0)
    assert.equal(context.entries.length, 0)

    await command.handler("restore work", context.ctx)
    assert.equal(context.confirmCalls, 1)
    assert.equal(context.shutdowns, 0)
    assert.equal(context.entries.length, 0)
  } finally {
    await fixture.close()
  }
})

test("when a named slot has no current snapshot, it stays listed but cannot shut down OMP", async () => {
  const fixture = await createFixture()
  try {
    await fixture.saveName()
    await rm(
      path.join(
        fixture.scope.agentDir,
        "instance-control",
        "restore",
        "snapshots",
        `${fixture.restoreId}.json`
      )
    )
    const context = createContext(fixture.cwd, {
      select: async (_title, choices) => choices[0],
    })
    const command = registerCommand(undefined, context.entries)

    await command.handler("restore --list --json", context.ctx)
    assert.ok(context.notifications.some(({ message }) => message.includes('"unavailable":')))
    const unavailableCompletion = command
      .getArgumentCompletions("restore ")
      .find((item) => item.value === "restore work")
    assert.ok(unavailableCompletion)
    await command.handler("restore", context.ctx)
    assert.equal(context.selectCalls, 1)
    assert.equal(context.confirmCalls, 0)
    assert.equal(context.shutdowns, 0)

    await command.handler("restore work", context.ctx)
    assert.equal(context.confirmCalls, 0)
    assert.equal(context.shutdowns, 0)
    assert.ok(context.notifications.some(({ level }) => level === "error"))
  } finally {
    await fixture.close()
  }
})

test("when an unmanaged OMP session has a different cwd, restore lookup uses launch-relative agent paths", async () => {
  const fixture = await createFixture({ relativeAgentDirectory: true })
  try {
    await fixture.saveName()
    const context = createContext(fixture.cwd)
    const command = registerCommand(undefined, context.entries)

    await command.handler("restore --list --json", context.ctx)

    assert.ok(context.notifications.some(({ message }) => message.includes('"name":"work"')))
    assert.ok(
      command.getArgumentCompletions("restore ").some((item) => item.value === "restore work")
    )
  } finally {
    await fixture.close()
  }
})
