import assert from "node:assert/strict"
import { access, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import test from "node:test"

import { createCommand, createContext, createFixture } from "./command-fixture.js"

async function writeWorkExecutable(executable) {
  const echoArguments = `console.log(JSON.stringify({
  argv,
  cwd: process.cwd(),
  configRoot: process.env.PI_CONFIG_DIR,
  profile: process.env.OMP_PROFILE,
  agentDir: process.env.PI_CODING_AGENT_DIR,
}))`
  await mkdir(path.dirname(executable), {
    recursive: true,
  })
  await writeFile(
    executable,
    [
      `#!${process.execPath}`,
      "const argv = process.argv.slice(2)",
      'if (argv.join(" ") === "control work --help") {',
      '  console.log("Usage: ompi control work list|find|set|clear")',
      "} else {",
      echoArguments,
      "}",
      "",
    ].join("\n"),
    {
      mode: 0o700,
    }
  )
}

function createWorkRuntime(ctx, root, executable) {
  const configRoot = path.join(root, "managed config")
  const agentDir = path.join(configRoot, "profiles", "managed", "agent")
  return {
    ctx,
    instanceId: "0123456789abcdef0123456789abcdef",
    launch: {
      native: {
        executable,
      },
      scope: {
        configRoot,
        agentDir,
        profile: "managed",
      },
    },
  }
}

test("when setting work, slash sends literal summary argv to its managed native wrapper in its scope", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  process.env.PATH = path.join(fixture.root, "without ompi")
  process.env.OMP_PROFILE = "ambient"
  const executable = path.join(fixture.root, "managed bin", "ompi")
  await writeWorkExecutable(executable)
  const ctx = createContext(fixture.cwd)
  const sessionFile = path.join(fixture.root, "saved conversation.ndjson")
  ctx.sessionManager = {
    getSessionId: () => "my-session",
    getSessionFile: () => sessionFile,
  }
  const runtime = createWorkRuntime(ctx, fixture.root, executable)
  const ui = createCommand(ctx, {
    runtime,
  })
  const url = "https://github.com/OWNER/Repo/issues/93"
  const summary = '--profile=other  "quoted" $(not-a-command); café\nnext line'

  // Act
  await ui.command.handler(`work set --branch issue-93/session-work ${url} ${summary}`, ctx)

  // Assert
  assert.deepEqual(JSON.parse(ui.notifications[0].message), {
    argv: [
      "control",
      "work",
      "set",
      "--expect-session-id=my-session",
      `--expect-session-file=${sessionFile}`,
      "--branch=issue-93/session-work",
      "--",
      "0123456789abcdef0123456789abcdef",
      "https://github.com/OWNER/Repo/issues/93",
      '--profile=other  "quoted" $(not-a-command); café\nnext line',
    ],
    cwd: fixture.cwd,
    configRoot: path.join(fixture.root, "managed config"),
    profile: "managed",
    agentDir: path.join(fixture.root, "managed config", "profiles", "managed", "agent"),
  })
})

test("when clearing work, slash passes only its full launch ID and both saved-session guards", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  const executable = path.join(fixture.root, "managed bin", "ompi")
  await writeWorkExecutable(executable)
  const ctx = createContext(fixture.cwd)
  const sessionFile = path.join(fixture.root, "saved conversation.ndjson")
  ctx.sessionManager = {
    getSessionId: () => "my-session",
    getSessionFile: () => sessionFile,
  }
  const runtime = createWorkRuntime(ctx, fixture.root, executable)
  const ui = createCommand(ctx, {
    runtime,
  })

  // Act
  await ui.command.handler("work clear", ctx)

  // Assert
  assert.deepEqual(JSON.parse(ui.notifications[0].message).argv, [
    "control",
    "work",
    "clear",
    "--expect-session-id=my-session",
    `--expect-session-file=${sessionFile}`,
    "--",
    "0123456789abcdef0123456789abcdef",
  ])
})

test("when a standalone plugin finds work, slash uses PATH and delegates the explicit profile and JSON options", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  process.env.PATH = path.join(fixture.root, "standalone bin")
  await writeWorkExecutable(path.join(process.env.PATH, "ompi"))
  const ctx = createContext(fixture.cwd)
  const ui = createCommand(ctx)

  // Act
  await ui.command.handler(
    "work find https://github.com/owner/repo/pull/93 --profile other --json",
    ctx
  )

  // Assert
  assert.deepEqual(JSON.parse(ui.notifications[0].message), {
    argv: [
      "control",
      "work",
      "find",
      "--profile=other",
      "--json",
      "--",
      "https://github.com/owner/repo/pull/93",
    ],
    cwd: fixture.cwd,
    configRoot: path.join(fixture.root, "config"),
    profile: "",
    agentDir: path.join(fixture.root, "config", "agent"),
  })
})

test("when slash work lacks native ompi on PATH, it reports the missing dependency", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  process.env.PATH = path.join(fixture.root, "without ompi")
  const ctx = createContext(fixture.cwd)
  const ui = createCommand(ctx)

  // Act
  await ui.command.handler("work list", ctx)

  // Assert
  assert.deepEqual(ui.notifications, [
    {
      level: "error",
      message: "Native ompi was not found on PATH; install an ompi version with work support.",
    },
  ])
})

test("when the native wrapper lacks work support, slash asks for an update", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  process.env.PATH = fixture.root
  await writeFile(path.join(fixture.root, "ompi"), `#!${process.execPath}\nprocess.exit(2)\n`, {
    mode: 0o700,
  })
  const ctx = createContext(fixture.cwd)
  const ui = createCommand(ctx)

  // Act
  await ui.command.handler("work list", ctx)

  // Assert
  assert.deepEqual(ui.notifications, [
    {
      level: "error",
      message: "This native ompi version does not report work support; update ompi and try again.",
    },
  ])
})

test("when the conversation cwd disappeared, slash work reports the cwd instead of a missing dependency", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  process.env.PATH = path.join(fixture.root, "without ompi")
  const ctx = createContext(path.join(fixture.root, "missing worktree"))
  const ui = createCommand(ctx)

  // Act
  await ui.command.handler("work list", ctx)

  // Assert
  assert.equal(ui.notifications[0].level, "error")
  assert.match(ui.notifications[0].message, /working directory for \/ompi work is unavailable/)
})

test("when a standalone session requests work clear, slash refuses without using PATH for mutation", async () => {
  // Arrange
  const ctx = createContext(process.cwd())
  const ui = createCommand(ctx)

  // Act
  await ui.command.handler("work clear", ctx)

  // Assert
  assert.deepEqual(ui.notifications, [
    {
      level: "error",
      message: "/ompi work set and clear require this session to be running under ompi.",
    },
  ])
})

test("when slash work clear is given profile or peer arguments, it refuses the request", async () => {
  // Arrange
  const ctx = createContext(process.cwd())
  const ui = createCommand(ctx)

  // Act
  await ui.command.handler("work clear --profile other abcd", ctx)

  // Assert
  assert.deepEqual(ui.notifications, [
    {
      level: "error",
      message: "Usage: /ompi work clear (this managed session only).",
    },
  ])
})

test("when slash work targets a different transcript than the managed session, it refuses mutation", async () => {
  // Arrange
  const cwd = process.cwd()
  const ctx = createContext(cwd)
  ctx.sessionManager = {
    getSessionId: () => "same-session-id",
    getSessionFile: () => path.join(cwd, "old.ndjson"),
  }
  const managedCtx = createContext(cwd)
  managedCtx.sessionManager = {
    getSessionId: () => "same-session-id",
    getSessionFile: () => path.join(cwd, "replacement.ndjson"),
  }
  const runtime = createWorkRuntime(managedCtx, cwd, path.join(cwd, "not-needed"))
  const ui = createCommand(ctx, {
    runtime,
  })

  // Act
  await ui.command.handler("work clear", ctx)

  // Assert
  assert.deepEqual(ui.notifications, [
    {
      level: "error",
      message: "This command no longer matches the managed session; run /ompi work again.",
    },
  ])
})

test("when the managed session changes during native discovery, slash refuses work mutation", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  const executable = path.join(fixture.root, "ompi")
  const socket = path.join(fixture.root, "probe.sock")
  const clearMarker = path.join(fixture.root, "clear-called")
  await writeFile(
    executable,
    `#!${process.execPath}
if (process.argv.slice(2).join(" ") === "control work --help") {
  require("node:net").connect(${JSON.stringify(socket)}).on("end", () => {
    console.log("Usage: ompi control work")
  }).resume()
} else {
  require("node:fs").writeFileSync(${JSON.stringify(clearMarker)}, "called")
}
`,
    {
      mode: 0o700,
    }
  )
  const ctx = createContext(fixture.cwd)
  let sessionFile = path.join(fixture.root, "original.ndjson")
  ctx.sessionManager = {
    getSessionId: () => "same-session-id",
    getSessionFile: () => sessionFile,
  }
  const runtime = createWorkRuntime(ctx, fixture.root, executable)
  const ui = createCommand(ctx, {
    runtime,
  })
  let probeStarted = false
  const server = createServer((connection) => {
    probeStarted = true
    sessionFile = path.join(fixture.root, "replacement.ndjson")
    connection.end()
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  t.after(() => server.close())

  // Act
  await ui.command.handler("work clear", ctx)

  // Assert
  assert.equal(probeStarted, true)
  await assert.rejects(access(clearMarker), {
    code: "ENOENT",
  })
  assert.deepEqual(ui.notifications, [
    {
      level: "error",
      message: "The managed session changed; run /ompi work again in the intended session.",
    },
  ])
})

test("when completing slash work, selector options stop before a mutation's literal summary", () => {
  // Arrange
  const { command } = createCommand(createContext(process.cwd()))
  const cases = [
    ["wo", ["work"]],
    ["help wo", ["help work"]],
    ["work ", ["work list", "work find", "work set", "work clear"]],
    ["work list --", ["work list --profile", "work list --json"]],
    ["work list --help --", []],
    ["work list --json=false --", []],
    ["work list --profile --profile=de", []],
    ["work find --branch feature --", []],
    ["work find --profile=de", ["work find --profile=default"]],
    ["work set --", ["work set --branch"]],
    ["work clear --", []],
    ["work set https://github.com/owner/repo/issues/93 --", []],
  ]

  // Act
  const candidates = cases.map(([input]) =>
    command.getArgumentCompletions(input).map(({ value }) => value)
  )

  // Assert
  assert.deepEqual(
    candidates,
    cases.map(([, expected]) => expected)
  )
})

test("when completing work profile names, slash reads only the managed configuration root", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  const ctx = createContext(fixture.cwd)
  const runtime = createWorkRuntime(ctx, fixture.root, path.join(fixture.root, "unused"))
  await mkdir(path.join(runtime.launch.scope.configRoot, "profiles", "team"), {
    recursive: true,
  })
  await mkdir(path.join(fixture.root, "config", "profiles", "ambient"), {
    recursive: true,
  })
  const ui = createCommand(ctx, {
    runtime,
  })
  await ui.refreshCompletions(ctx)

  // Act
  const candidates = ui.command.getArgumentCompletions("work list --profile ")

  // Assert
  assert.deepEqual(
    candidates.map(({ value }) => value),
    ["work list --profile default", "work list --profile managed", "work list --profile team"]
  )
})
