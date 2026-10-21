import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { importLegacyRecovery } from "../../linux/recovery.js"
import { getScope } from "../../protocol/index.js"

async function createFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-legacy-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scope = getScope({
    cwd: root,
    env: {
      HOME: root,
      PI_CONFIG_DIR: path.join(root, "config"),
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
    },
  })
  await mkdir(scope.agentDir, { mode: 0o700 })
  return { root, scope }
}

test("when importing old shell-quoted data, apostrophes and literal backslashes survive without evaluation", async (t) => {
  // Arrange
  const { root, scope } = await createFixture(t)
  const cwd = path.join(root, "work'folder")
  await mkdir(cwd)
  const sessionId = "session\\name'quoted"
  const sessionDirectory = path.join(scope.agentDir, "sessions")
  await mkdir(sessionDirectory, { recursive: true })
  const sessionFile = path.join(sessionDirectory, "session.jsonl")
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", id: sessionId })}\n${JSON.stringify({ id: "not-the-session-header" })}\n`,
    { mode: 0o600 }
  )
  const source = path.join(root, "snapshot.txt")
  const shellQuotedCwd = `'${cwd.replaceAll("'", "'\\''")}'`
  const shellQuotedId = `'${sessionId.replaceAll("'", "'\\''")}'`
  await writeFile(
    source,
    `cd ${shellQuotedCwd} && omp --resume ${shellQuotedId}\ncd '/tmp' && omp --resume 'session-id'; touch SHOULD_NOT_EXIST\n`,
    { mode: 0o600 }
  )

  // Act
  const imported = await importLegacyRecovery(scope, source)

  // Assert
  assert.equal(imported.length, 1)
  assert.deepEqual(imported[0].legacy, [{ cwd, sessionId, sessionFile }])
  assert.deepEqual(imported[0].warnings, ["line 2: unsupported legacy command format"])
})

test("when importing the same legacy source again, the immutable checkpoint is reused", async (t) => {
  // Arrange
  const { root, scope } = await createFixture(t)
  const source = path.join(root, "snapshot.txt")
  await writeFile(source, "cd '/work' && omp --resume 'session-id'\n", { mode: 0o600 })

  // Act
  const first = await importLegacyRecovery(scope, source)
  const second = await importLegacyRecovery(scope, source)

  // Assert
  assert.equal(first[0].checkpointId, second[0].checkpointId)
  assert.equal(second[0].createdAt, first[0].createdAt)
})

test("when an imported transcript is large, its bounded session header remains readable", async (t) => {
  // Arrange
  const { root, scope } = await createFixture(t)
  const cwd = path.join(root, "work")
  await mkdir(cwd)
  const sessionId = "large-session"
  const sessionDirectory = path.join(scope.agentDir, "sessions")
  await mkdir(sessionDirectory, { recursive: true })
  const sessionFile = path.join(sessionDirectory, "large.jsonl")
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", id: sessionId })}\n${"x".repeat(128 * 1024)}\n`,
    { mode: 0o600 }
  )
  const source = path.join(root, "snapshot.txt")
  await writeFile(source, `cd '${cwd}' && omp --resume '${sessionId}'\n`, { mode: 0o600 })

  // Act
  const imported = await importLegacyRecovery(scope, source)

  // Assert
  assert.equal(imported.length, 1)
  assert.deepEqual(imported[0].legacy, [{ cwd, sessionId, sessionFile }])
})
