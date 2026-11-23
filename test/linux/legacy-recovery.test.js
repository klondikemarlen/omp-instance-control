import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  exportRecoveryCommands,
  listRecoveryCheckpoints,
  listRecoverySessions,
  writeRecoveryCheckpoint,
} from "../../linux/recovery.js"
import { validateLegacyRecoveryEntry } from "../../linux/legacy-recovery.js"
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

test("retained legacy history, listing, and export preserve exact title-prefixed transcripts and original source files", async (t) => {
  const { root, scope } = await createFixture(t)
  const cwd = path.join(root, "work'folder")
  const sessionDirectory = path.join(scope.agentDir, "sessions")
  await mkdir(cwd)
  await mkdir(sessionDirectory)

  const sessionFile = path.join(sessionDirectory, "title.jsonl")
  const sessionId = "session\\name'quoted"
  const title = JSON.stringify({
    type: "title",
    v: 1,
    title: "Example",
  }).padEnd(255)
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
  })
  await writeFile(sessionFile, `${title}\n${header}\n${"x".repeat(128 * 1024)}\n`, {
    mode: 0o600,
  })

  const sourcePath = path.join(root, "old-snapshot.txt")
  const source = "historical shell command data; not executed\n"
  const sourceSha256 = createHash("sha256").update(source).digest("hex")
  await writeFile(sourcePath, source, {
    mode: 0o600,
  })
  const entry = {
    cwd,
    sessionId,
    sessionFile,
  }
  const checkpointId = "a".repeat(32)
  const checkpoint = {
    version: 1,
    checkpointId,
    scope,
    bootId: "legacy",
    createdAt: new Date().toISOString(),
    reason: "legacy",
    entries: [],
    legacy: [entry],
    sourcePath,
    sourceSha256,
  }
  await writeRecoveryCheckpoint(scope, checkpoint)
  const executable = path.join(root, "ompi")
  await writeFile(executable, "not executed\n", {
    mode: 0o700,
  })
  const previousPath = process.env.PATH
  process.env.PATH = root
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })

  const history = await listRecoveryCheckpoints(scope)
  const sessions = await listRecoverySessions(scope, {
    checkpointId,
  })
  const exported = await exportRecoveryCommands(scope, sessions)

  assert.deepEqual(history, [checkpoint])
  assert.deepEqual(sessions, [
    {
      legacy: entry,
    },
  ])
  assert.ok(exported.includes(`# Imported legacy session (unowned): ${sessionId}`))
  assert.ok(exported.includes(`cd '${cwd.replaceAll("'", "'\\''")}' && env `))
  assert.ok(exported.includes(` '${executable}' -r '${sessionFile}'\n`))
  assert.equal(await readFile(sourcePath, "utf8"), source)
})

test("legacy validation rejects changed session IDs, unrelated prefix records, and oversized headers", async (t) => {
  const { root, scope } = await createFixture(t)
  const sessionDirectory = path.join(scope.agentDir, "sessions")
  await mkdir(sessionDirectory)

  const sessionFile = path.join(sessionDirectory, "test.jsonl")
  const entry = {
    cwd: root,
    sessionId: "retained",
    sessionFile,
  }
  const headers = [
    ['{"type":"session","id":"other"}\n', /Legacy transcript ID changed/],
    [
      '{"type":"message"}\n{"type":"session","id":"retained"}\n',
      /Legacy transcript header is invalid/,
    ],
    [
      `{"type":"session","id":"retained","padding":"${"x".repeat(64 * 1024)}"}\n`,
      /Legacy transcript header is invalid/,
    ],
  ]

  for (const [header, error] of headers) {
    await writeFile(sessionFile, header, {
      mode: 0o600,
    })
    await assert.rejects(() => validateLegacyRecoveryEntry(scope, entry), error)
  }
})
