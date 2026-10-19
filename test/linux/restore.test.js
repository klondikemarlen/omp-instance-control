import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  assertRestoreOwnersNotLive,
  getCurrentAgentOwner,
  listSavedSessions,
  saveRestoreName,
  validateRestoreName,
  writeRestoreSnapshot,
} from "../../linux/restore.js"
import { getScope } from "../../protocol/index.js"

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ic-restore-"))
  const cwd = path.join(root, "worktree")
  const sessionFile = path.join(root, "session.jsonl")
  await mkdir(cwd)
  await writeFile(sessionFile, "persisted session\n", { mode: 0o644 })
  const scope = getScope({
    cwd,
    env: {
      HOME: root,
      PI_CONFIG_DIR: path.join(root, "config"),
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
    },
  })

  return {
    root,
    cwd,
    sessionFile,
    scope,
    async close() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

function createSnapshot(fixture, restoreId, sessionId, sessionFile = fixture.sessionFile) {
  return {
    version: 1,
    restoreId,
    scope: {
      id: fixture.scope.id,
      configRoot: fixture.scope.configRoot,
      profile: fixture.scope.profile,
      agentDir: fixture.scope.agentDir,
    },
    sessionFile,
    sessionId,
    cwd: fixture.cwd,
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
}

test("when a restore name already exists, saving another session never retargets it", async () => {
  const fixture = await createFixture()
  try {
    const first = createSnapshot(fixture, "1".repeat(32), "first-session")
    const second = createSnapshot(fixture, "2".repeat(32), "second-session")
    await writeRestoreSnapshot(fixture.scope, first)
    await writeRestoreSnapshot(fixture.scope, second)

    await saveRestoreName(fixture.scope, "work", first.restoreId)
    await assert.rejects(
      saveRestoreName(fixture.scope, "work", second.restoreId),
      /already exists and cannot be overwritten/
    )

    const saved = await listSavedSessions(fixture.scope)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, "work")
    assert.equal(saved[0].session.restoreId, first.restoreId)
    assert.equal(saved[0].session.sessionId, "first-session")
  } finally {
    await fixture.close()
  }
})

test("when resume arguments contain NUL, snapshot persistence refuses them", async () => {
  const fixture = await createFixture()
  try {
    const snapshot = createSnapshot(fixture, "5".repeat(32), "unsafe-arguments")
    snapshot.resumeArgs = ["--system-prompt", "bad\u0000argument"]

    await assert.rejects(
      writeRestoreSnapshot(fixture.scope, snapshot),
      /resume arguments are missing or unsafe/
    )
  } finally {
    await fixture.close()
  }
})

test("when one saved session file disappears, other names remain listable and its save is refused", async () => {
  const fixture = await createFixture()
  try {
    const healthy = createSnapshot(fixture, "3".repeat(32), "healthy-session")
    const missingFile = path.join(fixture.root, "to-be-removed.jsonl")
    await writeFile(missingFile, "persisted session\n", { mode: 0o600 })
    const stale = createSnapshot(fixture, "4".repeat(32), "stale-session", missingFile)
    await writeRestoreSnapshot(fixture.scope, healthy)
    await writeRestoreSnapshot(fixture.scope, stale)
    await saveRestoreName(fixture.scope, "healthy", healthy.restoreId)
    await saveRestoreName(fixture.scope, "stale", stale.restoreId)
    await rm(missingFile)

    const saved = await listSavedSessions(fixture.scope)
    assert.deepEqual(
      saved.map((entry) => entry.name),
      ["healthy", "stale"]
    )
    await assert.rejects(
      saveRestoreName(fixture.scope, "another-name", stale.restoreId),
      /session file is unavailable/
    )
  } finally {
    await fixture.close()
  }
})
test("when the launcher is gone but its OMP agent remains alive, named restore is refused", async () => {
  const stoppedLauncher = {
    bootId: "00000000-0000-0000-0000-000000000000",
    pid: 999999,
    startTime: "1",
  }
  const liveAgent = await getCurrentAgentOwner()

  await assert.rejects(
    assertRestoreOwnersNotLive(stoppedLauncher, liveAgent),
    /OMP agent that owns this saved session is still running/
  )
})

test("when restore names use reserved or unsafe syntax, validation refuses them", () => {
  for (const name of ["save", "../work", "-work", "", "a".repeat(65)]) {
    assert.throws(() => validateRestoreName(name))
  }
  assert.equal(validateRestoreName("work.session-1"), "work.session-1")
})
