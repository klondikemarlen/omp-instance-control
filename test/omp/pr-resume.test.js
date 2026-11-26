import assert from "node:assert/strict"
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { registerOmpiCommand } from "../../omp/command.js"
import { registerPRResumeControl } from "../../omp/pr-resume-control.js"
import { getScope, PROTOCOL_VERSION } from "../../protocol/index.js"
import { createFixture } from "./command-fixture.js"

const URL = "https://github.com/owner/repo/pull/111"
const TIME = "2026-11-01T14:00:00.000Z"
const COMMAND = `resume ${URL}`

async function writeJournal(directory, sessionId, cwd) {
  const sessionFile = path.join(directory, `2026-11-01T14-00-00-000Z_${sessionId}.jsonl`)
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    cwd,
    timestamp: TIME,
  }
  const leaf = {
    type: "message",
    id: `${sessionId}-leaf`,
    parentId: null,
    timestamp: TIME,
    message: {
      role: "assistant",
      content: [],
    },
  }
  const transcript = `${JSON.stringify(header)}\n${JSON.stringify(leaf)}\n`
  await writeFile(sessionFile, transcript, {
    mode: 0o600,
  })
  return {
    sessionId,
    sessionFile,
    header,
    leaf,
    transcript,
  }
}

async function createResumeFixture(t, { freshStart = false } = {}) {
  const fixture = await createFixture()
  t.after(fixture.close)
  const { cwd } = fixture
  const scope = getScope({ cwd })
  const directory = path.join(scope.agentDir, "sessions", "--worktree")
  const executable = path.join(fixture.root, "native-ompi")
  const claimsPath = path.join(fixture.root, "claims.json")
  const nativeCallsPath = path.join(fixture.root, "native-argv.jsonl")
  await mkdir(directory, {
    mode: 0o700,
    recursive: true,
  })
  const source = await writeJournal(directory, "source-conversation", cwd)
  const target = await writeJournal(directory, "target-conversation", cwd)
  if (freshStart) {
    await unlink(source.sessionFile)
  }
  const nativeTool = [
    `#!${process.execPath}`,
    'const { appendFileSync, readFileSync } = require("node:fs")',
    "const args = process.argv.slice(2)",
    'if (args.includes("--help")) {',
    '  console.log("Usage: ompi control work COMMAND [OPTIONS]")',
    "} else {",
    `  appendFileSync(${JSON.stringify(nativeCallsPath)}, JSON.stringify(args) + "\\n")`,
    `  process.stdout.write(readFileSync(${JSON.stringify(claimsPath)}))`,
    "}",
  ].join("\n")
  await writeFile(executable, nativeTool, {
    mode: 0o700,
  })

  function makeClaim({ sessionFile, sessionId, header }, branch) {
    return {
      version: 1,
      scope: scope.id,
      url: URL,
      sessionFile,
      sessionId,
      cwd: header.cwd,
      branch,
      summary: "PR continuation",
      updatedAt: TIME,
    }
  }
  const claim = makeClaim(target, "issue-111/resume-pr")
  await writeFile(claimsPath, JSON.stringify([claim]))

  const records = []
  const notifications = []
  const switches = []
  const entries = []
  const picks = []
  const confirms = []
  const ownLeases = new Map()
  const otherLeases = new Set()
  const unknownLeases = new Set()
  const sessions = new Map([
    [source.sessionFile, source],
    [target.sessionFile, target],
  ])
  let active = source
  let command
  let editorText = ""

  class SessionManager {
    getSessionId() {
      return active.sessionId
    }

    getSessionFile() {
      return active.sessionFile
    }

    getCwd() {
      return active.header.cwd
    }

    getRecordedCwd() {
      return active.header.cwd
    }

    getHeader() {
      return active.header
    }

    isSessionOnDisk() {
      return !freshStart || active !== source
    }

    getEntries() {
      return this.isSessionOnDisk() ? [active.leaf] : []
    }

    getLeafId() {
      return active.leaf.id
    }
  }

  class FileSessionStorage {
    claimSession(sessionId, file) {
      if (otherLeases.has(sessionId) || sessions.get(file)?.sessionId !== sessionId) {
        return null
      }

      ownLeases.set(sessionId, (ownLeases.get(sessionId) ?? 0) + 1)
      return () => {
        const remaining = ownLeases.get(sessionId) - 1
        if (remaining > 0) {
          ownLeases.set(sessionId, remaining)
        } else {
          ownLeases.delete(sessionId)
        }
      }
    }

    isSessionOwnedElsewhere(file) {
      return otherLeases.has(sessions.get(file)?.sessionId)
    }
  }

  const ctx = {
    cwd,
    agent: {
      kind: "main",
    },
    mode: "tui",
    sessionManager: new SessionManager(),
    isIdle: () => true,
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => null,
    async switchSession(sessionFile) {
      const session = sessions.get(sessionFile)
      assert.equal(ownLeases.has(active.sessionId), !freshStart)
      assert.equal(ownLeases.has(session.sessionId), true)
      switches.push(sessionFile)
      active = session
      return {
        cancelled: false,
      }
    },
    ui: {
      getEditorText: () => editorText,
      setEditorText(text) {
        editorText = text
      },
      async select(title, choices) {
        picks.push([title, choices])
        return choices[0]
      },
      async confirm(title, description) {
        confirms.push([title, description])
        return true
      },
      notify(message, type) {
        notifications.push([message, type])
      },
    },
  }
  const runtime = {
    ctx,
    instanceId: "d".repeat(32),
    transport: {
      readRecords: async () => records,
    },
    origin: {
      sessionId: source.sessionId,
      sessionFile: source.sessionFile,
      cwd,
    },
    launch: {
      pid: process.ppid,
      scope,
      directory: fixture.root,
      token: "e".repeat(32),
      native: {
        executable,
      },
      ...(freshStart
        ? {
            prResume: {
              url: URL,
              cwd,
            },
          }
        : {}),
    },
  }
  const pi = {
    pi: {
      FileSessionStorage,
      SessionManager,
      KeybindingsManager: {
        inMemory: () => ({}),
      },
      probeSessionLeases(ids) {
        return {
          held: ids.filter((id) => ownLeases.has(id) || otherLeases.has(id)),
          unknown: ids.filter((id) => unknownLeases.has(id)),
        }
      },
      async readSessionHeaderId(file) {
        const data = await readFile(file, "utf8")
        return JSON.parse(data.split("\n")[0]).id
      },
    },
    registerCommand(_name, registered) {
      command = registered
    },
    appendEntry(customType) {
      entries.push([active.sessionId, customType])
      new FileSessionStorage().claimSession(active.sessionId, active.sessionFile)
    },
  }
  const getRuntime = () => runtime
  const prResume = registerPRResumeControl(pi, getRuntime)
  registerOmpiCommand(pi, {
    getRuntime,
    runPRResume: prResume.run,
  })

  return {
    ctx,
    command,
    prResume,
    runtime,
    records,
    source,
    target,
    switches,
    entries,
    notifications,
    picks,
    confirms,
    ownLeases,
    otherLeases,
    unknownLeases,
    nativeCallsPath,
    resultPath: path.join(fixture.root, "pr-resume-result.json"),
    async setClaims(...claims) {
      await writeFile(claimsPath, JSON.stringify(claims))
    },
    async addCandidate(id, branch, candidateCwd = cwd) {
      const session = await writeJournal(directory, id, candidateCwd)
      sessions.set(session.sessionFile, session)
      return makeClaim(session, branch)
    },
    makeClaim,
  }
}

test("when slash resumes a selected PR claim, it verifies the original session and keeps its lease", async (t) => {
  // Arrange
  const fixture = await createResumeFixture(t)
  const { command, ctx, source, target } = fixture
  const extra = await fixture.addCandidate("different-conversation", "other/PR work\u202e")
  await fixture.setClaims(fixture.makeClaim(target, "wanted/PR work"), extra)
  const pick = ctx.ui.select
  ctx.ui.select = async (title, choices) => {
    await pick(title, choices)
    return choices.find((choice) => choice.includes("wanted/PR work"))
  }

  // Act
  await command.handler(COMMAND, ctx)

  // Assert
  assert.equal(fixture.picks[0][0], "Choose a PR conversation to resume")
  assert.equal(fixture.picks[0][1].length, 2)
  assert.ok(fixture.picks[0][1].some((choice) => choice.includes("other/PR work?")))
  assert.equal(fixture.confirms[0][0], "Resume the original PR conversation?")
  assert.equal(ctx.sessionManager.getSessionId(), target.sessionId)
  assert.equal(ctx.sessionManager.getSessionFile(), target.sessionFile)
  assert.deepEqual(fixture.switches, [target.sessionFile])
  assert.deepEqual(fixture.entries, [[target.sessionId, "ompi-pr-resume"]])
  assert.deepEqual([...fixture.ownLeases], [[target.sessionId, 1]])
  assert.equal(fixture.runtime.resumingPR, false)
  assert.equal(await readFile(source.sessionFile, "utf8"), source.transcript)
  assert.deepEqual(fixture.notifications, [
    ["Resumed the original PR conversation in this terminal.", "info"],
  ])
  const argv = (await readFile(fixture.nativeCallsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(argv, [
    ["control", "work", "find", "--json", "--", URL],
    ["control", "work", "find", "--json", "--", URL],
  ])
})

test("when one PR claim matches, cancelling selection does not confirm or change the session", async (t) => {
  // Arrange
  const { command, ctx, source, switches, confirms, notifications } = await createResumeFixture(t)
  ctx.ui.select = async () => undefined

  // Act
  await command.handler(COMMAND, ctx)

  // Assert
  assert.equal(ctx.sessionManager.getSessionId(), source.sessionId)
  assert.deepEqual(confirms, [])
  assert.deepEqual(switches, [])
  assert.deepEqual(notifications, [["PR resume cancelled.", "info"]])
})

test("when the PR conversation is already active here, slash does not write or acquire another lease", async (t) => {
  // Arrange
  const fixture = await createResumeFixture(t)
  const { command, ctx, source, switches, confirms, entries, notifications } = fixture
  await fixture.setClaims(fixture.makeClaim(source, "active/pr"))

  // Act
  await command.handler(COMMAND, ctx)

  // Assert
  assert.deepEqual(confirms, [])
  assert.deepEqual(switches, [])
  assert.deepEqual(entries, [])
  assert.deepEqual(notifications, [
    ["This PR conversation is already active in this terminal.", "info"],
  ])
})

test("when the target disappears during confirmation, slash keeps the current session", async (t) => {
  // Arrange
  const { command, ctx, source, target, switches, ownLeases, notifications } =
    await createResumeFixture(t)
  ctx.ui.confirm = async () => {
    await unlink(target.sessionFile)
    return true
  }

  // Act
  await command.handler(COMMAND, ctx)

  // Assert
  assert.equal(ctx.sessionManager.getSessionId(), source.sessionId)
  assert.deepEqual(switches, [])
  assert.equal(ownLeases.size, 0)
  assert.match(notifications[0][0], /selected PR conversation changed or disappeared/)
  assert.equal(notifications[0][1], "error")
})

test("when the host reports a switch but stays on the source, slash does not claim success", async (t) => {
  // Arrange
  const { command, ctx, source, notifications, ownLeases, entries } = await createResumeFixture(t)
  ctx.switchSession = async () => ({
    cancelled: false,
  })

  // Act
  await command.handler(COMMAND, ctx)

  // Assert
  assert.equal(ctx.sessionManager.getSessionId(), source.sessionId)
  assert.deepEqual(entries, [])
  assert.equal(ownLeases.size, 0)
  assert.match(notifications[0][0], /OMP did not confirm the selected original PR conversation/)
  assert.equal(notifications[0][1], "error")
})

test("when source work becomes pending during confirmation, slash refuses to interrupt it", async (t) => {
  // Arrange
  const { command, ctx, source, switches, notifications } = await createResumeFixture(t)
  ctx.ui.confirm = async () => {
    ctx.hasPendingMessages = () => true
    return true
  }

  // Act
  await command.handler(COMMAND, ctx)

  // Assert
  assert.equal(ctx.sessionManager.getSessionId(), source.sessionId)
  assert.deepEqual(switches, [])
  assert.match(notifications[0][0], /busy or has pending work/)
  assert.equal(notifications[0][1], "error")
})

test("when an ordinary OMP process owns the target lease, slash redirects to its terminal", async (t) => {
  // Arrange
  const fixture = await createResumeFixture(t)
  fixture.otherLeases.add(fixture.target.sessionId)

  // Act
  await fixture.command.handler(COMMAND, fixture.ctx)

  // Assert
  assert.deepEqual(fixture.confirms, [])
  assert.deepEqual(fixture.switches, [])
  assert.match(fixture.notifications[0][0], /open in another OMP process/)
  assert.equal(fixture.notifications[0][1], "error")
})

test("when a managed restart is pending for the target, slash refuses an unleased target", async (t) => {
  // Arrange
  const fixture = await createResumeFixture(t)
  fixture.records.push({
    instanceId: "a".repeat(32),
    pid: process.pid,
    state: "restart-requested",
    sessionId: fixture.target.sessionId,
    sessionFile: fixture.target.sessionFile,
  })

  // Act
  await fixture.command.handler(COMMAND, fixture.ctx)

  // Assert
  assert.deepEqual(fixture.confirms, [])
  assert.deepEqual(fixture.switches, [])
  assert.match(fixture.notifications[0][0], /active or restarting ompi owner/)
  assert.equal(fixture.notifications[0][1], "error")
})

test("when the selected claim belongs to another directory, slash offers only manual resume", async (t) => {
  // Arrange
  const fixture = await createResumeFixture(t)
  const otherDirectory = path.join(fixture.ctx.cwd, "other-project")
  const claim = await fixture.addCandidate("other-project", "work/PR", otherDirectory)
  await fixture.setClaims(claim)

  // Act
  await fixture.command.handler(COMMAND, fixture.ctx)

  // Assert
  assert.deepEqual(fixture.switches, [])
  assert.deepEqual(fixture.confirms, [])
  assert.match(fixture.notifications[0][0], /uses another directory.*\/resume picker manually/)
  assert.equal(fixture.notifications[0][1], "error")
})

test("when slash resume is given an issue URL or a profile override, it reports usage", async (t) => {
  // Arrange
  const { command, ctx, switches, notifications } = await createResumeFixture(t)

  // Act
  await command.handler("resume https://github.com/owner/repo/issues/111", ctx)
  await command.handler(`${COMMAND} --profile other`, ctx)
  await command.handler(`resume -- ${URL}`, ctx)

  // Assert
  assert.deepEqual(switches, [])
  assert.equal(notifications.length, 3)
  for (const [message, type] of notifications) {
    assert.match(message, /^Usage: \/ompi resume /)
    assert.equal(type, "error")
  }
})

test("when using the retired slash resume spelling, it shows migration help without looking up work", async (t) => {
  const { command, ctx, switches, notifications, picks } = await createResumeFixture(t)

  await command.handler(`work ${COMMAND}`, ctx)

  assert.deepEqual(picks, [])
  assert.deepEqual(switches, [])
  assert.deepEqual(notifications, [["PR resume moved to /ompi resume PR_URL.", "error"]])
})

test("when requesting slash resume help, it describes the guarded operation without opening a chooser", async (t) => {
  const { command, ctx, notifications, picks } = await createResumeFixture(t)

  await command.handler("help resume", ctx)
  await command.handler("resume --help", ctx)

  assert.deepEqual(picks, [])
  assert.equal(notifications.length, 2)
  assert.equal(notifications[0][1], "info")
  assert.match(
    notifications[0][0],
    /^Usage: \/ompi resume https:\/\/github.com\/OWNER\/REPO\/pull\/N/
  )
  assert.deepEqual(notifications[1], notifications[0])
})

test("when completing slash resume, only the root command and its help option are suggested", async (t) => {
  const { command } = await createResumeFixture(t)
  const cases = [
    ["resu", ["resume"]],
    ["help resu", ["help resume"]],
    ["resume --", ["resume --help"]],
    ["resume ", []],
    [`${COMMAND} --`, []],
  ]

  for (const [input, expected] of cases) {
    assert.deepEqual(
      command.getArgumentCompletions(input).map(({ value }) => value),
      expected
    )
  }
})

test("when OMP starts for shell PR resume, prefill alone never opens the original", async (t) => {
  const {
    command,
    prResume,
    runtime,
    ctx,
    picks,
    confirms,
    switches,
    source,
    target,
    ownLeases,
    resultPath,
  } = await createResumeFixture(t, {
    freshStart: true,
  })

  await prResume.prepareLaunch(runtime, ctx, runtime.launch.scope)

  assert.equal(ctx.ui.getEditorText(), `/ompi ${COMMAND}`)
  assert.deepEqual(picks, [])
  assert.deepEqual(confirms, [])
  assert.deepEqual(switches, [])
  assert.equal(ownLeases.size, 0)
  await assert.rejects(access(resultPath), {
    code: "ENOENT",
  })

  const submittedCommand = ctx.ui.getEditorText().slice("/ompi ".length)
  ctx.ui.setEditorText("")
  await command.handler(submittedCommand, ctx)

  assert.equal(confirms.length, 1)
  assert.deepEqual(switches, [target.sessionFile])
  assert.deepEqual([...ownLeases], [[target.sessionId, 1]])
  await assert.rejects(access(source.sessionFile), {
    code: "ENOENT",
  })
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
    version: PROTOCOL_VERSION,
    token: runtime.launch.token,
    status: "resumed",
    message: "Resumed the original PR conversation in this terminal.",
  })

  await prResume.prepareLaunch(runtime, ctx, runtime.launch.scope)
  assert.equal(ctx.ui.getEditorText(), "")
})

test("when OMP's editor holds a draft at startup, shell PR resume leaves it untouched", async (t) => {
  const { prResume, runtime, ctx, switches, resultPath } = await createResumeFixture(t, {
    freshStart: true,
  })
  ctx.ui.setEditorText("An existing draft")

  await prResume.prepareLaunch(runtime, ctx, runtime.launch.scope)

  assert.equal(ctx.ui.getEditorText(), "An existing draft")
  assert.deepEqual(switches, [])
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
    version: PROTOCOL_VERSION,
    token: runtime.launch.token,
    status: "refused",
    message: "Cannot prepare shell PR resume without an empty OMP editor.",
  })
})

test("when OMP started in a different profile, shell resume refuses before showing any candidates", async (t) => {
  const { prResume, runtime, ctx, picks, resultPath } = await createResumeFixture(t, {
    freshStart: true,
  })

  await prResume.prepareLaunch(runtime, ctx, {
    id: "another-profile",
  })

  assert.equal(ctx.ui.getEditorText(), "")
  assert.deepEqual(picks, [])
  assert.equal(JSON.parse(await readFile(resultPath, "utf8")).status, "refused")
})
