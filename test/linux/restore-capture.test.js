import assert from "node:assert/strict"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { captureRestoreSnapshot, readRestoreSnapshot } from "../../linux/restore.js"
import { getScope } from "../../protocol/index.js"

async function createCaptureFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-capture-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionFile = path.join(root, "session.jsonl")
  const scope = getScope({
    cwd: root,
    env: {
      HOME: root,
      PI_CONFIG_DIR: path.join(root, "config"),
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
    },
  })
  const launch = {
    restoreId: "a".repeat(32),
    resumeArgs: [],
    owner: {
      bootId: "00000000-0000-0000-0000-000000000000",
      pid: 999999,
      startTime: "1",
    },
  }
  const ctx = {
    cwd: root,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => "current-session",
    },
  }
  return { root, sessionFile, scope, launch, ctx }
}

test("when a new session has not written its transcript, restore capture stays pending", async (t) => {
  // Arrange
  const { scope, launch, ctx } = await createCaptureFixture(t)

  // Act
  const captured = await captureRestoreSnapshot(scope, launch, ctx)

  // Assert
  assert.equal(captured, false)
})

test("when a pending session writes its transcript, restore capture becomes available", async (t) => {
  // Arrange
  const { sessionFile, scope, launch, ctx } = await createCaptureFixture(t)
  await captureRestoreSnapshot(scope, launch, ctx)
  await writeFile(sessionFile, "persisted session\n", { mode: 0o600 })

  // Act
  await captureRestoreSnapshot(scope, launch, ctx)

  // Assert
  const snapshot = await readRestoreSnapshot(scope, launch.restoreId)
  assert.equal(snapshot.sessionFile, sessionFile)
  assert.equal(snapshot.sessionId, "current-session")
})

test("when the current transcript disappears, capture invalidates the predecessor snapshot", async (t) => {
  // Arrange
  const { sessionFile, scope, launch, ctx } = await createCaptureFixture(t)
  await writeFile(sessionFile, "persisted session\n", { mode: 0o600 })
  await captureRestoreSnapshot(scope, launch, ctx)
  await rm(sessionFile)

  // Act
  await captureRestoreSnapshot(scope, launch, ctx)

  // Assert
  assert.equal(await readRestoreSnapshot(scope, launch.restoreId), null)
})

test("when the transcript path is a symlink, restore capture still refuses it", async (t) => {
  // Arrange
  const { root, sessionFile, scope, launch, ctx } = await createCaptureFixture(t)
  const target = path.join(root, "target.jsonl")
  await writeFile(target, "persisted session\n", { mode: 0o600 })
  await symlink(target, sessionFile)

  // Act / Assert
  await assert.rejects(captureRestoreSnapshot(scope, launch, ctx), /Saved session file is unsafe/)
})
