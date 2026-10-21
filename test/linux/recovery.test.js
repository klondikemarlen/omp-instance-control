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

async function createFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
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
