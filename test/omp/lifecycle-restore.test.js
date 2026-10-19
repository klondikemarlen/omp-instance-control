import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import {
  listSavedSessions,
  readRestoreSnapshot,
  saveRestoreName,
  writeRestoreSnapshot,
} from "../../linux/restore.js"
import instanceControl from "../../omp/index.js"
import { getScope } from "../../protocol/index.js"

const ENVIRONMENT_KEYS = [
  "HOME",
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_RUNTIME_DIR",
  "OMP_INSTANCE_CONTROL_LAUNCH_DIR",
  "OMP_INSTANCE_CONTROL_LAUNCH_TOKEN",
]

function createEventBus() {
  const listeners = new Map()
  return {
    emit(channel, value) {
      for (const listener of listeners.get(channel) ?? []) listener(value)
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

async function createSessionFile(directory, name) {
  const file = path.join(directory, `${name}.jsonl`)
  await writeFile(file, `${name}\n`, { mode: 0o600 })
  return file
}

test("when lifecycle events change session or cwd, named restore follows the final persisted state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ic-restore-life-"))
  const launchDirectory = path.join(root, "launch")
  const workDirectory = path.join(root, "work")
  const nextDirectory = path.join(root, "next-work")
  await Promise.all([
    mkdir(launchDirectory, { mode: 0o700 }),
    mkdir(workDirectory),
    mkdir(nextDirectory),
  ])
  const token = "c".repeat(32)
  const restoreId = "d".repeat(32)
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
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const scope = getScope({ env: environment, cwd: workDirectory })
  const states = [
    {
      sessionId: "session-start",
      sessionFile: await createSessionFile(root, "start"),
      cwd: workDirectory,
    },
    {
      sessionId: "session-switch",
      sessionFile: await createSessionFile(root, "switch"),
      cwd: nextDirectory,
    },
    {
      sessionId: "session-branch",
      sessionFile: await createSessionFile(root, "branch"),
      cwd: workDirectory,
    },
    {
      sessionId: "agent-end",
      sessionFile: await createSessionFile(root, "agent-end"),
      cwd: nextDirectory,
    },
    {
      sessionId: "shutdown",
      sessionFile: await createSessionFile(root, "shutdown"),
      cwd: workDirectory,
    },
    {
      sessionId: "late-agent-end",
      sessionFile: await createSessionFile(root, "late"),
      cwd: nextDirectory,
    },
  ]
  let activeState = states[0]
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    get cwd() {
      return activeState.cwd
    },
    sessionManager: {
      getSessionId: () => activeState.sessionId,
      getSessionFile: () => activeState.sessionFile,
    },
    ui: {
      setStatus() {},
      notify(message) {
        assert.fail(message)
      },
    },
    shutdown() {},
  }
  const handlers = new Map()

  try {
    await writePrivateJson(path.join(launchDirectory, "launch.json"), {
      version: 1,
      token,
      pid: process.ppid,
      scope,
      extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
      lastRestart: null,
      builtinFlags: [],
      restoreId,
      resumeArgs: ["--system-prompt", "first line\nsecond line"],
      owner: {
        bootId: "00000000-0000-0000-0000-000000000000",
        pid: 999999,
        startTime: "1",
      },
    })
    await instanceControl({
      events: createEventBus(),
      pi: createSdk(),
      runtime: { flagValues: new Map() },
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    })

    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const records = await transport.readRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].restoreId, restoreId)

    const assertSnapshot = async (state) => {
      const snapshot = await readRestoreSnapshot(scope, restoreId)
      assert.equal(snapshot.sessionId, state.sessionId)
      assert.equal(snapshot.sessionFile, state.sessionFile)
      assert.equal(snapshot.cwd, state.cwd)
      assert.deepEqual(snapshot.resumeArgs, ["--system-prompt", "first line\nsecond line"])
      assert.equal(snapshot.agentOwner.pid, process.pid)
    }
    await assertSnapshot(states[0])
    await saveRestoreName(scope, "current", restoreId)

    const healthyRestoreId = "e".repeat(32)
    const firstSnapshot = await readRestoreSnapshot(scope, restoreId)
    await writeRestoreSnapshot(scope, {
      ...firstSnapshot,
      restoreId: healthyRestoreId,
      sessionId: "healthy-session",
    })
    await saveRestoreName(scope, "healthy", healthyRestoreId)

    activeState = {
      sessionId: "unpersisted-session",
      sessionFile: null,
      cwd: nextDirectory,
    }
    await handlers.get("session_switch")({}, ctx)
    assert.equal(await readRestoreSnapshot(scope, restoreId), null)
    const unavailableNames = await listSavedSessions(scope)
    const unavailableSlot = unavailableNames.find((entry) => entry.name === "current")
    assert.equal(unavailableSlot.session, undefined)
    assert.equal(
      unavailableNames.find((entry) => entry.name === "healthy").session.sessionId,
      "healthy-session"
    )

    activeState = states[1]
    await handlers.get("session_switch")({}, ctx)
    await assertSnapshot(states[1])
    const restoredNames = await listSavedSessions(scope)
    assert.equal(
      restoredNames.find((entry) => entry.name === "current").session.sessionId,
      states[1].sessionId
    )

    activeState = states[2]
    await handlers.get("session_branch")({}, ctx)
    await assertSnapshot(states[2])

    activeState = states[3]
    await handlers.get("agent_end")({}, ctx)
    await assertSnapshot(states[3])

    activeState = states[4]
    await handlers.get("session_shutdown")({}, ctx)
    await assertSnapshot(states[4])

    activeState = states[5]
    await handlers.get("agent_end")({}, ctx)
    await assertSnapshot(states[4])
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
