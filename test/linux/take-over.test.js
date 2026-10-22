import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  prepareNamedRestoreCommand,
  prepareResumeCommand,
  prepareSlotRestoreCommand,
} from "../../linux/take-over.js"
import { getScope } from "../../protocol/index.js"

const scopeEnvironmentKeys = [
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_RUNTIME_DIR",
]

async function createSandbox(t, { cwdName, sessionName, executableName, version = "0.12.0" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ompi-takeover-"))
  const cwd = path.join(root, cwdName ?? "worktree")
  const sessionFile = path.join(root, sessionName ?? "session.jsonl")
  const executable = path.join(root, executableName ?? "ompi-fake")
  const resultFile = path.join(root, "invocation.json")

  await mkdir(cwd, { recursive: true })
  await writeFile(sessionFile, "persisted session data\n")
  const versionOutput = ["0.10.9", "0.11.0"].includes(version) ? "18.12.6" : `ompi ${version}`
  const fakeExecutable = [
    `#!${process.execPath}`,
    'const { writeFileSync } = require("node:fs");',
    `const scopeKeys = ${JSON.stringify(scopeEnvironmentKeys)};`,
    `if (process.argv[2] === "control" && process.argv[3] === "--version") { console.log(${JSON.stringify(versionOutput)}); process.exit(0); }`,
    `writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({`,
    "  argv: process.argv.slice(2),",
    "  cwd: process.cwd(),",
    "  environment: Object.fromEntries(scopeKeys.map((key) => [key, process.env[key] ?? null])),",
    "}));",
    "",
  ].join("\n")
  await writeFile(executable, fakeExecutable)
  await chmod(executable, 0o755)
  t.after(() => rm(root, { recursive: true, force: true }))

  return { root, cwd, sessionFile, executable, resultFile }
}

function makeSnapshot(cwd, sessionFile) {
  return { cwd, sessionFile }
}

async function createRestoreSession(sandbox) {
  const env = { HOME: sandbox.root }
  const scope = getScope({ env, cwd: sandbox.cwd })
  return {
    scope,
    cwd: sandbox.cwd,
    sessionFile: sandbox.sessionFile,
    owner: {
      bootId: "00000000-0000-0000-0000-000000000000",
      pid: 1,
      startTime: "0",
    },
    agentOwner: {
      bootId: "00000000-0000-0000-0000-000000000000",
      pid: 1,
      startTime: "0",
    },
  }
}

test("when preparing a named restore, the command uses control restore and quotes arguments", async (t) => {
  // Arrange
  const sandbox = await createSandbox(t, {
    cwdName: "work ' directory",
    executableName: "ompi executable",
  })
  const session = await createRestoreSession(sandbox)
  const name = "saved-session"

  // Act
  const command = await prepareNamedRestoreCommand(session.scope, name, session, {
    env: { HOME: sandbox.root },
    executable: sandbox.executable,
  })
  const invocation = await runCommand(command, sandbox.resultFile)

  // Assert
  assert.deepEqual(invocation.argv, ["control", "restore", name, "--profile=default"])
})

test("when preparing a slot restore, the command checks control version and uses control restore", async (t) => {
  // Arrange
  const sandbox = await createSandbox(t)
  const session = await createRestoreSession(sandbox)
  const restoreId = "a".repeat(32)

  // Act
  const command = await prepareSlotRestoreCommand(session.scope, restoreId, session, {
    env: { HOME: sandbox.root },
    executable: sandbox.executable,
    assertOwnersNotLive: false,
  })
  const invocation = await runCommand(command, sandbox.resultFile)

  // Assert
  assert.deepEqual(invocation.argv, [
    "control",
    "restore",
    "--slot",
    restoreId,
    "--profile=default",
  ])
})

for (const version of ["0.10.9", "0.11.0", "0.12.0-rc.1"]) {
  test(`when native ompi is ${version}, named and slot restore refuse before generating commands`, async (t) => {
    // Arrange
    const sandbox = await createSandbox(t, { version })
    const session = await createRestoreSession(sandbox)

    // Act / Assert
    const unsupportedVersion = /0\.12\.0/
    await assert.rejects(
      prepareSlotRestoreCommand(session.scope, "a".repeat(32), session, {
        env: { HOME: sandbox.root },
        executable: sandbox.executable,
        assertOwnersNotLive: false,
      }),
      unsupportedVersion
    )
    await assert.rejects(
      prepareNamedRestoreCommand(session.scope, "saved-session", session, {
        env: { HOME: sandbox.root },
        executable: sandbox.executable,
      }),
      unsupportedVersion
    )
  })
}

test("when a saved working directory disappears, named restore refuses before preparing a command", async (t) => {
  // Arrange
  const sandbox = await createSandbox(t)
  const session = await createRestoreSession(sandbox)
  await rm(sandbox.cwd, { recursive: true })

  // Act / Assert
  await assert.rejects(
    prepareNamedRestoreCommand(session.scope, "saved-session", session, {
      env: { HOME: sandbox.root },
      executable: sandbox.executable,
    }),
    { code: "ENOENT" }
  )
})

async function runCommand(command, resultFile) {
  const child = spawnSync("/bin/sh", ["-c", command], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/ambient-home",
      PI_CONFIG_DIR: "/ambient-config",
      PI_CODING_AGENT_DIR: "/ambient-agent",
      OMP_PROFILE: "ambient-omp-profile",
      PI_PROFILE: "ambient-pi-profile",
      XDG_RUNTIME_DIR: "/ambient-runtime",
    },
  })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(await readFile(resultFile, "utf8"))
}

function injectionName(prefix, markerFile) {
  return `${prefix} ' $(touch ${path.basename(markerFile)})`
}

test("when named-profile paths contain shell syntax, resume preserves literal arguments and scope", async (t) => {
  // Arrange
  const markerForPaths = path.join(tmpdir(), `ompi-injection-${randomUUID()}`)
  t.after(() => rm(markerForPaths, { force: true }))
  const dangerous = (prefix) => injectionName(prefix, markerForPaths)
  const sandbox = await createSandbox(t, {
    cwdName: `work ${dangerous("cwd")}`,
    sessionName: `${dangerous("session")}.jsonl`,
    executableName: dangerous("ompi"),
  })
  const home = path.join(sandbox.root, dangerous("home"))
  const configRelative = dangerous("config")
  const agentRelative = dangerous("agent")
  const runtimeDirectory = path.join(sandbox.root, dangerous("runtime"))
  await Promise.all([mkdir(home), mkdir(runtimeDirectory)])
  const env = {
    HOME: home,
    PI_CONFIG_DIR: configRelative,
    PI_CODING_AGENT_DIR: agentRelative,
    PI_PROFILE: "work",
    XDG_RUNTIME_DIR: runtimeDirectory,
  }
  const configRoot = path.resolve(home, configRelative)
  const command = await prepareResumeCommand(makeSnapshot(sandbox.cwd, sandbox.sessionFile), {
    env,
    executable: sandbox.executable,
  })

  // Act
  const invocation = await runCommand(command, sandbox.resultFile)

  // Assert
  assert.deepEqual(invocation.argv, ["--profile=work", "-r", sandbox.sessionFile])
  assert.equal(invocation.cwd, sandbox.cwd)
  assert.deepEqual(invocation.environment, {
    PI_CONFIG_DIR: configRoot,
    PI_CODING_AGENT_DIR: null,
    OMP_PROFILE: null,
    PI_PROFILE: "work",
    XDG_RUNTIME_DIR: runtimeDirectory,
  })
  await assert.rejects(readFile(markerForPaths), { code: "ENOENT" })
})

test("when the default profile overrides its agent directory, resume preserves resolved scope", async (t) => {
  // Arrange
  const markerForPaths = path.join(tmpdir(), `ompi-default-injection-${randomUUID()}`)
  t.after(() => rm(markerForPaths, { force: true }))
  const dangerous = (prefix) => injectionName(prefix, markerForPaths)
  const sandbox = await createSandbox(t, {
    cwdName: `work ${dangerous("cwd")}`,
    sessionName: `${dangerous("session")}.jsonl`,
    executableName: dangerous("ompi"),
  })
  const home = path.join(sandbox.root, dangerous("home"))
  const configRelative = dangerous("config")
  const agentRelative = dangerous("agent")
  await mkdir(home)
  const env = {
    HOME: home,
    PI_CONFIG_DIR: configRelative,
    PI_CODING_AGENT_DIR: agentRelative,
  }
  const configRoot = path.resolve(home, configRelative)
  const agentDirectory = path.resolve(process.cwd(), agentRelative)
  const command = await prepareResumeCommand(makeSnapshot(sandbox.cwd, sandbox.sessionFile), {
    env,
    executable: sandbox.executable,
  })

  // Act
  const invocation = await runCommand(command, sandbox.resultFile)

  // Assert
  assert.deepEqual(invocation.argv, ["--profile=default", "-r", sandbox.sessionFile])
  assert.equal(invocation.cwd, sandbox.cwd)
  assert.deepEqual(invocation.environment, {
    PI_CONFIG_DIR: configRoot,
    PI_CODING_AGENT_DIR: agentDirectory,
    OMP_PROFILE: null,
    PI_PROFILE: "default",
    XDG_RUNTIME_DIR: null,
  })
  await assert.rejects(readFile(markerForPaths), { code: "ENOENT" })
})

test("when transcript paths are unavailable or unsafe, preparation rejects without execution", async (t) => {
  // Arrange
  const transcriptCases = [
    {
      name: "the session was not persisted",
      sessionFile: null,
      createSession: true,
    },
    {
      name: "the transcript file is missing",
      sessionFile: "missing-session.jsonl",
      createSession: false,
    },
    {
      name: "the transcript path is a directory",
      sessionFile: "session-directory",
      createSession: "directory",
    },
    {
      name: "the transcript file is empty",
      sessionFile: "empty-session.jsonl",
      createSession: "empty",
    },
  ]

  for (const scenario of transcriptCases) {
    await t.test(`when ${scenario.name}, preparation rejects`, async (subtest) => {
      // Arrange
      const sandbox = await createSandbox(subtest)
      const sessionPath =
        scenario.sessionFile === null ? null : path.join(sandbox.root, scenario.sessionFile)
      if (scenario.createSession === "directory") {
        await mkdir(sessionPath)
      }

      if (scenario.createSession === "empty") {
        await writeFile(sessionPath, "")
      }

      // Act
      const preparation = prepareResumeCommand(makeSnapshot(sandbox.cwd, sessionPath), {
        env: { PATH: "/usr/bin:/bin" },
        executable: sandbox.executable,
      })

      // Assert
      await assert.rejects(preparation)
      await assert.rejects(readFile(sandbox.resultFile), { code: "ENOENT" })
    })
  }

  for (const invalidValue of ["cwd", "session"]) {
    await t.test(
      `when ${invalidValue} contains control characters, preparation rejects`,
      async (subtest) => {
        // Arrange
        const sandbox = await createSandbox(subtest, {
          cwdName: invalidValue === "cwd" ? "work\nline" : "worktree",
          sessionName: invalidValue === "session" ? "session\nline.jsonl" : "session.jsonl",
        })

        // Act
        const preparation = prepareResumeCommand(makeSnapshot(sandbox.cwd, sandbox.sessionFile), {
          env: { PATH: "/usr/bin:/bin" },
          executable: sandbox.executable,
        })

        // Assert
        await assert.rejects(preparation)
        await assert.rejects(readFile(sandbox.resultFile), { code: "ENOENT" })
      }
    )
  }
})

test("when ompi is absent from PATH, preparation rejects", async (t) => {
  // Arrange
  const sandbox = await createSandbox(t)
  const env = { HOME: sandbox.root, PATH: path.join(sandbox.root, "missing-bin") }

  // Act
  const preparation = prepareResumeCommand(makeSnapshot(sandbox.cwd, sandbox.sessionFile), { env })

  // Assert
  await assert.rejects(preparation)
})

test("when the runtime directory is relative, preparation rejects", async (t) => {
  // Arrange
  const sandbox = await createSandbox(t)
  const env = { HOME: sandbox.root, XDG_RUNTIME_DIR: "relative-runtime" }

  // Act
  const preparation = prepareResumeCommand(makeSnapshot(sandbox.cwd, sandbox.sessionFile), {
    env,
    executable: sandbox.executable,
  })

  // Assert
  await assert.rejects(preparation)
})
