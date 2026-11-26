import assert from "node:assert/strict"
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile as writeJournalFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  findResumeCandidates,
  normalizePRResumeURL,
  revalidateResumeCandidate,
} from "../../linux/pr-resume.js"
import { getScope } from "../../protocol/index.js"

const prURL = "https://github.com/example/project/pull/42"
const timestamp = "2026-11-25T00:00:00.000Z"
const filename = (id) => `2026-11-25T00-00-00-000Z_${id}.jsonl`

function writeFile(file, content) {
  return writeJournalFile(file, content, {
    mode: 0o600,
  })
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ompi-pr-resume-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = {
    HOME: root,
  }
  const scope = getScope({
    env,
  })
  const bucket = path.join(scope.agentDir, "sessions", "-project")
  const cwd = path.join(root, "project")
  await mkdir(bucket, {
    mode: 0o700,
    recursive: true,
  })
  await mkdir(cwd)
  return {
    bucket,
    cwd,
    env,
    root,
    scope,
  }
}

function sessionHeader(id, cwd, fields = {}) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd,
    ...fields,
  }
}

function messageEntry(id, parentId, message) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message,
  }
}

function creationCall(
  command = "gh pr create --draft --title 'Title; still one argument' --body 'Fixes #17'"
) {
  return messageEntry("call", null, {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        name: "bash",
        id: "create-pr",
        arguments: {
          command,
        },
      },
    ],
  })
}

function creationResult(text = prURL, fields = {}, parentId = "call") {
  return messageEntry("result", parentId, {
    role: "toolResult",
    toolName: "bash",
    toolCallId: "create-pr",
    isError: false,
    content: [
      {
        type: "text",
        text,
      },
    ],
    ...fields,
  })
}

function workClaim(scope, cwd, sessionFile, sessionId) {
  return {
    version: 1,
    scope: scope.id,
    sessionId,
    sessionFile,
    cwd,
    url: prURL,
    summary: "Private work summary, not distinguishing evidence",
    branch: "private-branch",
    updatedAt: timestamp,
  }
}

function transferNotice(details) {
  return {
    type: "custom_message",
    customType: "session-transfer",
    content: "Private transfer notice",
    details,
  }
}

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

test("when claims and creation records match, lookup distinguishes their evidence", async (t) => {
  // Arrange
  const { bucket, cwd, scope } = await createFixture(t)
  const historical = path.join(bucket, filename("historical"))
  const claimed = path.join(bucket, filename("claimed"))
  const title = JSON.stringify({
    type: "title",
    v: 1,
    title: `Private title mentioning ${prURL}`,
    updatedAt: timestamp,
    pad: "",
  }).padEnd(255)
  const olderActivity = new Date(timestamp)
  const latestActivity = new Date("2026-11-25T01:00:00.000Z")
  const result = creationResult(
    [
      "Warning: 1 uncommitted change",
      "Creating draft pull request for feature into main in Example/Project",
      "https://github.com/Example/Project/pull/42",
      "",
      "Wall time: 1.23 seconds",
    ].join("\n"),
    {
      details: {
        wallTimeNoticeEmitted: true,
        wallTimeMs: 1234,
      },
    }
  )
  await writeFile(
    historical,
    `${title}\n${jsonl(sessionHeader("historical", cwd), creationCall(), result)}`
  )
  await utimes(historical, olderActivity, olderActivity)
  await writeFile(claimed, jsonl(sessionHeader("claimed", cwd), creationCall(), creationResult()))
  await utimes(claimed, latestActivity, latestActivity)

  // Act
  const candidates = await findResumeCandidates(
    scope,
    prURL,
    [workClaim(scope, cwd, claimed, "claimed")],
    cwd
  )

  // Assert
  assert.deepEqual(candidates, [
    {
      sessionId: "claimed",
      sessionFile: claimed,
      cwd,
      evidence: "Explicit work claim",
      updatedAt: latestActivity.toISOString(),
    },
    {
      sessionId: "historical",
      sessionFile: historical,
      cwd,
      evidence: "Created this pull request",
      updatedAt: olderActivity.toISOString(),
    },
  ])
})

test("when a transcript only mentions the PR or lacks a successful creation, lookup excludes it", async (t) => {
  // Arrange
  const { bucket, cwd, scope } = await createFixture(t)
  const mention = messageEntry("call", null, {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `I created ${prURL} using gh pr create`,
      },
    ],
  })
  const unsuccessful = [
    ["assistant-mention", mention, creationResult()],
    ["read-existing", creationCall("gh pr view --json url"), creationResult()],
    ["quoted-command", creationCall('echo "gh pr create"'), creationResult()],
    ["conditional", creationCall(`gh pr create || echo '${prURL}'`), creationResult()],
    ["compound", creationCall(`gh pr create; printf '%s\\n' '${prURL}'`), creationResult()],
    ["command-substitution", creationCall('gh pr create --body "$(cat body)"'), creationResult()],
    ["web-preview", creationCall("gh pr create --'web'"), creationResult()],
    ["dry-run", creationCall("gh pr create --dry-run"), creationResult()],
    ["not-executed", creationCall()],
    [
      "uncorrelated",
      creationCall(),
      creationResult(prURL, {
        toolCallId: "a-different-call",
      }),
    ],
    ["different-branch", creationCall(), creationResult(prURL, {}, "a-different-parent")],
    [
      "different-tool",
      creationCall(),
      creationResult(prURL, {
        toolName: "read",
      }),
    ],
    [
      "error",
      creationCall(),
      creationResult(prURL, {
        isError: true,
      }),
    ],
    [
      "nonzero-exit",
      creationCall(),
      creationResult(prURL, {
        details: {
          exitCode: 1,
        },
      }),
    ],
    ["different-pr", creationCall(), creationResult("https://github.com/example/project/pull/420")],
    ["merged-output", creationCall(), creationResult(`Pull request already exists:\n${prURL}`)],
    ["multiple-urls", creationCall(), creationResult(`${prURL}\n${prURL}0`)],
    [
      "unstructured",
      creationCall(),
      creationResult(prURL, {
        content: prURL,
      }),
    ],
  ]
  for (const [id, ...records] of unsuccessful) {
    await writeFile(path.join(bucket, filename(id)), jsonl(sessionHeader(id, cwd), ...records))
  }

  // Act
  const candidates = await findResumeCandidates(scope, prURL, [], cwd)

  // Assert
  assert.deepEqual(candidates, [])
})

test("when claims outlive their transcripts, only a matching saved identity is offered", async (t) => {
  // Arrange
  const { bucket, cwd, scope } = await createFixture(t)
  const valid = path.join(bucket, filename("valid"))
  const recycled = path.join(bucket, filename("recycled"))
  const malformed = path.join(bucket, filename("malformed"))
  const wrongScope = path.join(bucket, filename("wrong-scope"))
  const missing = path.join(bucket, filename("missing"))
  await writeFile(valid, jsonl(sessionHeader("valid", cwd)))
  await writeFile(recycled, jsonl(sessionHeader("some-other-id", cwd)))
  const shortTitle = {
    type: "title",
    v: 1,
  }
  await writeFile(malformed, jsonl(shortTitle, sessionHeader("malformed", cwd)))
  await writeFile(wrongScope, jsonl(sessionHeader("wrong-scope", cwd)))
  const claims = [
    workClaim(scope, "/private/stale-claim-directory", valid, "valid"),
    workClaim(scope, cwd, recycled, "recycled"),
    workClaim(scope, cwd, malformed, "malformed"),
    workClaim(
      {
        id: "0000000000000000",
      },
      cwd,
      wrongScope,
      "wrong-scope"
    ),
    workClaim(scope, cwd, missing, "missing"),
  ]

  // Act
  const candidates = await findResumeCandidates(scope, prURL, claims, cwd)

  // Assert
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].sessionId, "valid")
  assert.equal(candidates[0].cwd, cwd)
  assert.equal(candidates[0].evidence, "Explicit work claim")
})

test("when work belongs to another directory, only its explicit claim is listed", async (t) => {
  // Arrange
  const { bucket, cwd, root, scope } = await createFixture(t)
  const sessionFile = path.join(bucket, filename("other-project"))
  const otherCwd = path.join(root, "other-project")
  await writeFile(
    sessionFile,
    jsonl(sessionHeader("other-project", otherCwd), creationCall(), creationResult())
  )

  const claim = workClaim(scope, otherCwd, sessionFile, "other-project")

  // Act
  const unclaimed = await findResumeCandidates(scope, prURL, [], cwd)
  const [candidate] = await findResumeCandidates(scope, prURL, [claim], cwd)

  // Assert
  assert.deepEqual(unclaimed, [])
  assert.equal(candidate.sessionFile, sessionFile)
  assert.equal(candidate.cwd, otherCwd)
  assert.equal(candidate.evidence, "Explicit work claim")
})

test("when journals cross a storage boundary, lookup excludes them from the current profile", async (t) => {
  // Arrange
  const { bucket, cwd, env, scope } = await createFixture(t)
  const other = getScope({
    env,
    profile: "other",
  })
  const otherBucket = path.join(other.agentDir, "sessions", "-project")
  const artifact = path.join(bucket, "2026-11-25T00-00-00-000Z_parent", "agent")
  const foreign = path.join(otherBucket, filename("foreign"))
  const nested = path.join(artifact, filename("subprocess"))
  const symlinked = path.join(bucket, filename("foreign"))
  const hardlinked = path.join(bucket, filename("hardlinked"))
  const outsideHardlink = path.join(otherBucket, filename("hardlinked"))
  const readOnly = path.join(bucket, filename("readonly"))
  const chrome = path.join(bucket, filename("chrome"))
  const fork = path.join(bucket, filename("fork"))
  await mkdir(otherBucket, {
    mode: 0o700,
    recursive: true,
  })
  await mkdir(artifact, {
    mode: 0o700,
    recursive: true,
  })
  for (const [id, file] of [
    ["foreign", foreign],
    ["subprocess", nested],
    ["hardlinked", outsideHardlink],
    ["readonly", readOnly],
  ]) {
    await writeFile(file, jsonl(sessionHeader(id, cwd), creationCall(), creationResult()))
  }
  const chromeHeader = sessionHeader("chrome", cwd, {
    origin: "chrome",
  })
  await writeFile(chrome, jsonl(chromeHeader, creationCall(), creationResult()))
  const forkHeader = sessionHeader("fork", cwd, {
    parentSession: "original",
  })
  await writeFile(fork, jsonl(forkHeader, creationCall(), creationResult()))
  await chmod(readOnly, 0o400)
  await symlink(foreign, symlinked)
  await symlink(otherBucket, path.join(path.dirname(bucket), "-alias"))
  await link(outsideHardlink, hardlinked)
  const claims = [
    workClaim(scope, cwd, foreign, "foreign"),
    workClaim(scope, cwd, nested, "subprocess"),
    workClaim(scope, cwd, symlinked, "foreign"),
    workClaim(scope, cwd, hardlinked, "hardlinked"),
    workClaim(scope, cwd, readOnly, "readonly"),
  ]

  // Act
  const matches = await findResumeCandidates(scope, prURL, claims, cwd)
  const otherMatches = await findResumeCandidates(other, prURL, [], cwd)

  // Assert
  assert.deepEqual(matches, [])
  assert.deepEqual(
    otherMatches.map(({ sessionId }) => sessionId),
    ["foreign"]
  )
})

test("when a large message precedes PR creation, the original conversation is found", async (t) => {
  // Arrange
  const { bucket, cwd, scope } = await createFixture(t)
  const sessionFile = path.join(bucket, filename("long-session"))
  const largeMessage = messageEntry("earlier", null, {
    role: "user",
    content: "x".repeat(600 * 1024),
  })
  await writeFile(
    sessionFile,
    jsonl(sessionHeader("long-session", cwd), largeMessage, creationCall(), creationResult())
  )

  // Act
  const [candidate] = await findResumeCandidates(scope, prURL, [], cwd)

  // Assert
  assert.equal(candidate.sessionId, "long-session")
  assert.equal(candidate.evidence, "Created this pull request")
})

test("when an older journal lacks tree IDs, ordered tool results identify PR creation", async (t) => {
  // Arrange
  const { bucket, cwd, scope } = await createFixture(t)
  const sessionFile = path.join(bucket, filename("legacy"))
  const header = sessionHeader("legacy", cwd, {
    version: undefined,
  })
  const call = messageEntry(undefined, undefined, creationCall().message)
  const result = messageEntry(undefined, undefined, creationResult().message)
  await writeFile(sessionFile, jsonl(header, call, result))

  // Act
  const [candidate] = await findResumeCandidates(scope, prURL, [], cwd)

  // Assert
  assert.equal(candidate.sessionId, "legacy")
  assert.equal(candidate.evidence, "Created this pull request")
})

test("when a selected transcript moves or disappears, revalidation rejects its stale identity", async (t) => {
  // Arrange
  const { bucket, cwd, scope } = await createFixture(t)
  const sessionFile = path.join(bucket, filename("selected"))
  const claim = workClaim(scope, cwd, sessionFile, "selected")
  const original = jsonl(sessionHeader("selected", cwd))
  await writeFile(sessionFile, original)
  // Act
  const [candidate] = await findResumeCandidates(scope, prURL, [claim], cwd)
  // Assert
  assert.deepEqual(await revalidateResumeCandidate(scope, prURL, [claim], candidate), candidate)

  const departed = transferNotice({
    kind: "departed",
    to: "another-machine",
  })
  await appendFile(sessionFile, jsonl(departed))
  assert.equal(await revalidateResumeCandidate(scope, prURL, [claim], candidate), null)
  assert.deepEqual(await findResumeCandidates(scope, prURL, [claim], cwd), [])

  const arrived = transferNotice({
    kind: "arrived",
    fromCwd: "/another-machine/project",
    cwd,
  })
  await appendFile(sessionFile, jsonl(arrived))
  const returned = await revalidateResumeCandidate(scope, prURL, [claim], candidate)
  assert.equal(returned?.sessionId, "selected")

  const forked = transferNotice({
    kind: "forked",
    source: "old-session",
    to: "remote",
  })
  await appendFile(sessionFile, jsonl(forked))
  assert.equal(await revalidateResumeCandidate(scope, prURL, [claim], candidate), null)

  await writeFile(sessionFile, jsonl(sessionHeader("selected", path.join(cwd, "moved"))))
  assert.equal(await revalidateResumeCandidate(scope, prURL, [claim], candidate), null)

  await writeFile(sessionFile, jsonl(sessionHeader("replacement", cwd)))
  assert.equal(await revalidateResumeCandidate(scope, prURL, [claim], candidate), null)

  await rm(sessionFile)
  assert.equal(await revalidateResumeCandidate(scope, prURL, [claim], candidate), null)
})

test("when ownership evidence disappears or a transfer is unreadable, revalidation refuses resume", async (t) => {
  // Arrange
  const { bucket, cwd, scope } = await createFixture(t)
  const sessionFile = path.join(bucket, filename("historical"))
  const header = jsonl(sessionHeader("historical", cwd))
  await writeFile(sessionFile, `${header}${jsonl(creationCall(), creationResult())}`)
  const [candidate] = await findResumeCandidates(scope, prURL, [], cwd)

  const opaque = transferNotice({
    kind: "departed",
    to: "x".repeat(600 * 1024),
  })
  // Act
  await appendFile(sessionFile, jsonl(opaque))
  // Assert
  assert.equal(await revalidateResumeCandidate(scope, prURL, [], candidate), null)

  await writeFile(sessionFile, header)
  assert.equal(await revalidateResumeCandidate(scope, prURL, [], candidate), null)
})

test("when a resume URL is provided, only a qualified GitHub PR is accepted", () => {
  // Arrange
  const inputs = [
    "https://github.com/Example/Project/pull/42",
    "https://github.com/example/project/issues/42",
    "https://github.com/example/project/pull/42?x=y",
    "https://github.com@example.org/example/project/pull/42",
    "https://github.com/example/project/pull/18446744073709551616",
  ]

  // Act
  const normalized = inputs.map(normalizePRResumeURL)

  // Assert
  assert.deepEqual(normalized, [prURL, null, null, null, null])
})
