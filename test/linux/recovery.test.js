import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  captureRecoveryCheckpoint,
  listRecoveryCheckpoints,
  listRecoverySessions,
  writeRecoveryCheckpoint,
} from "../../linux/recovery.js"
import { saveRestoreName, writeRestoreSnapshot } from "../../linux/restore.js"
import { getScope } from "../../protocol/index.js"
import { createTransport } from "../../linux/transport.js"

async function createFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previousRuntime = process.env.XDG_RUNTIME_DIR
  process.env.XDG_RUNTIME_DIR = path.join(root, "r")
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousRuntime
  })
  const scope = getScope({
    cwd: root,
    env: {
      HOME: root,
      PI_CONFIG_DIR: path.join(root, "config"),
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
    },
  })
  return { root, scope }
}

test("when capturing an empty managed scope, recovery retains a meaningful empty checkpoint", async (t) => {
  // Arrange
  const { scope } = await createFixture(t)

  // Act
  const checkpoint = await captureRecoveryCheckpoint(scope, { reason: "manual" })

  // Assert
  assert.deepEqual(checkpoint.entries, [])
  assert.equal(checkpoint.reason, "manual")
  assert.deepEqual(await listRecoveryCheckpoints(scope), [checkpoint])
})

test("when listing sessions without checkpoints, recovery discovers no fabricated candidates", async (t) => {
  // Arrange
  const { scope } = await createFixture(t)

  // Act
  const sessions = await listRecoverySessions(scope)

  // Assert
  assert.deepEqual(sessions, [])
})

test("when a checkpoint contains a now-unavailable named slot, listing preserves its alias and restore ID", async (t) => {
  // Arrange
  const { root, scope } = await createFixture(t)
  const cwd = path.join(root, "work")
  const sessionFile = path.join(root, "session.jsonl")
  const restoreId = "c".repeat(32)
  await mkdir(cwd)
  await writeFile(sessionFile, "persisted session\n", { mode: 0o600 })
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
    sessionId: "checkpoint-session",
    cwd,
    resumeArgs: [],
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
  await writeRestoreSnapshot(scope, snapshot)
  await saveRestoreName(scope, "work", restoreId)
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
  const checkpoint = {
    version: 1,
    checkpointId: "d".repeat(32),
    scope: {
      id: scope.id,
      configRoot: scope.configRoot,
      profile: scope.profile,
      agentDir: scope.agentDir,
    },
    bootId,
    createdAt: new Date().toISOString(),
    reason: "manual",
    entries: [{ restoreId, sessionId: snapshot.sessionId, cwd }],
  }
  await writeRecoveryCheckpoint(scope, checkpoint)
  await rm(
    path.join(scope.agentDir, "instance-control", "restore", "snapshots", `${restoreId}.json`)
  )

  // Act
  const sessions = await listRecoverySessions(scope, { checkpointId: checkpoint.checkpointId })

  // Assert
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].restoreId, restoreId)
  assert.equal(sessions[0].name, "work")
  assert.match(sessions[0].unavailable, /No current persisted session snapshot/)
})

for (const { condition, previousMembers, currentMembers, expectedMembers } of [
  {
    condition: "an empty previous boot precedes current sessions",
    previousMembers: false,
    currentMembers: true,
    expectedMembers: true,
  },
  {
    condition: "normal exit empties current membership",
    previousMembers: true,
    currentMembers: false,
    expectedMembers: false,
  },
  {
    condition: "both boots have empty membership",
    previousMembers: false,
    currentMembers: false,
    expectedMembers: false,
  },
]) {
  test(`when ${condition}, default recovery preserves the latest useful set without resurrection`, async (t) => {
    // Arrange
    const { root, scope } = await createFixture(t)
    const restoreId = "a".repeat(32)
    const sessionFile = path.join(root, "conversation.jsonl")
    await writeFile(sessionFile, "persisted conversation\n", { mode: 0o600 })
    const owner = { bootId: "00000000-0000-0000-0000-000000000000", pid: 999999, startTime: "1" }
    const snapshot = {
      version: 1,
      restoreId,
      scope,
      sessionFile,
      sessionId: "current-conversation",
      cwd: root,
      resumeArgs: [],
      owner,
      agentOwner: owner,
      updatedAt: new Date().toISOString(),
    }
    await writeRestoreSnapshot(scope, snapshot)
    const entry = { restoreId, sessionId: snapshot.sessionId, cwd: root }
    const previous = {
      version: 1,
      checkpointId: "b".repeat(32),
      scope,
      bootId: "00000000-0000-0000-0000-000000000000",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "automatic",
      entries: previousMembers ? [entry] : [],
    }
    await writeRecoveryCheckpoint(scope, previous)
    await writeRecoveryCheckpoint(scope, {
      ...previous,
      checkpointId: "c".repeat(32),
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      createdAt: "2026-01-02T00:00:00.000Z",
      entries: currentMembers ? [entry] : [],
    })

    // Act
    const sessions = await listRecoverySessions(scope)
    const explicitPrevious = await listRecoverySessions(scope, {
      checkpointId: previous.checkpointId,
    })

    // Assert
    assert.deepEqual(sessions, expectedMembers ? [{ restoreId, session: snapshot }] : [])
    assert.deepEqual(explicitPrevious, previousMembers ? [{ restoreId, session: snapshot }] : [])
  })
}

test("when automatic captures race, history retains one transition and manual captures remain distinct", async (t) => {
  // Arrange
  const { root, scope } = await createFixture(t)
  const restoreId = "a".repeat(32)
  const sessionFile = path.join(root, "conversation.jsonl")
  await writeFile(sessionFile, "persisted conversation\n", { mode: 0o600 })
  const owner = { bootId: "00000000-0000-0000-0000-000000000000", pid: 999999, startTime: "1" }
  const snapshot = {
    version: 1,
    restoreId,
    scope,
    sessionFile,
    sessionId: "current-conversation",
    cwd: root,
    resumeArgs: [],
    owner,
    agentOwner: owner,
    updatedAt: new Date().toISOString(),
  }
  await writeRestoreSnapshot(scope, snapshot)
  const transport = await createTransport(scope)
  await transport.writeRecord({
    version: 1,
    instanceId: "d".repeat(32),
    scope: scope.id,
    pid: process.pid,
    cwd: root,
    sessionId: snapshot.sessionId,
    sessionFile,
    launcherManaged: true,
    state: "running",
    operationId: null,
    lastRestart: null,
    restoreId,
  })

  // Act
  const captures = await Promise.all(
    Array.from({ length: 12 }, () => captureRecoveryCheckpoint(scope))
  )
  const emptied = await captureRecoveryCheckpoint(scope, { excludeRestoreId: restoreId })
  const returned = await captureRecoveryCheckpoint(scope)
  const manual = await captureRecoveryCheckpoint(scope, { reason: "manual" })
  const history = await listRecoveryCheckpoints(scope)

  // Assert
  assert.deepEqual(captures, Array(12).fill(captures[0]))
  assert.notEqual(manual.checkpointId, captures[0].checkpointId)
  assert.deepEqual(emptied.entries, [])
  assert.deepEqual(returned.entries, [{ restoreId, sessionId: snapshot.sessionId, cwd: root }])
  assert.notEqual(returned.checkpointId, captures[0].checkpointId)
  assert.deepEqual(
    new Set(history.map((entry) => entry.checkpointId)),
    new Set([
      manual.checkpointId,
      captures[0].checkpointId,
      emptied.checkpointId,
      returned.checkpointId,
    ])
  )
})

test("when the previous capture is ahead of the clock, a closing transition stays authoritative", async (t) => {
  // Arrange
  const { root, scope } = await createFixture(t)
  const previous = {
    version: 1,
    checkpointId: "a".repeat(32),
    scope,
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    createdAt: new Date(Date.now() + 60_000).toISOString(),
    reason: "manual",
    entries: [{ restoreId: "b".repeat(32), sessionId: "closed-conversation", cwd: root }],
  }
  await writeRecoveryCheckpoint(scope, previous)

  // Act
  const closing = await captureRecoveryCheckpoint(scope)
  const sessions = await listRecoverySessions(scope)

  // Assert
  assert.deepEqual(sessions, [])
  assert.deepEqual(await listRecoveryCheckpoints(scope), [closing, previous])
})

test("when native timestamps differ below a millisecond, history selects the newest nanoseconds", async (t) => {
  // Arrange
  const { scope } = await createFixture(t)
  const older = {
    version: 1,
    checkpointId: "f".repeat(32),
    scope,
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    createdAt: "2026-01-01T00:00:00.123000001Z",
    reason: "manual",
    entries: [],
  }
  const newer = {
    ...older,
    checkpointId: "a".repeat(32),
    createdAt: "2026-01-01T00:00:00.123000002Z",
  }
  await writeRecoveryCheckpoint(scope, older)
  await writeRecoveryCheckpoint(scope, newer)

  // Act
  const history = await listRecoveryCheckpoints(scope)

  // Assert
  assert.deepEqual(history, [newer, older])
})
