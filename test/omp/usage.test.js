import assert from "node:assert/strict"
import { access, link, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { getScope } from "../../protocol/index.js"

import { createCommand, createContext, createFixture } from "./command-fixture.js"

function usageDirectory(scope) {
  return path.join(scope.agentDir, "instance-control", "usage-v1")
}

test("when no countable command is dispatched with opt-in, slash creates no usage state", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  const ctx = createContext(fixture.cwd)
  const ui = createCommand(ctx)
  const scope = getScope({ cwd: fixture.cwd })
  const directory = usageDirectory(scope)

  // Act
  for (const setting of [undefined, "0", "true"]) {
    if (setting === undefined) delete process.env.OMPI_USAGE
    else process.env.OMPI_USAGE = setting
    await ui.command.handler("list", ctx)
  }

  process.env.OMPI_USAGE = "1"
  await ui.refreshCompletions(ctx)
  const completions = ui.command.getArgumentCompletions("restore ") ?? []
  assert.ok(!completions.some((item) => item.value.includes("import-legacy")))
  await ui.command.handler("help restore", ctx)
  assert.doesNotMatch(ui.notifications.at(-1).message, /import-legacy/)
  await ui.command.handler("version", ctx)
  await ui.command.handler("work list --help", ctx)
  await ui.command.handler("list invalid", ctx)
  await ui.command.handler("restore import-legacy", ctx)
  // Assert
  assert.equal(ui.notifications.at(-1).level, "error")
  assert.match(ui.notifications.at(-1).message, /Legacy import has been removed/)

  await assert.rejects(access(directory), {
    code: "ENOENT",
  })
})

test("when plain OMP dispatches commands, only fixed categories accumulate in its own scope", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  process.env.OMPI_USAGE = "1"
  process.env.PATH = path.join(fixture.root, "without ompi")
  const ctx = createContext(fixture.cwd)
  const ui = createCommand(ctx)
  const invokedScope = getScope({ cwd: fixture.cwd })
  const otherScope = getScope({
    cwd: fixture.cwd,
    profile: "other",
  })
  const directory = usageDirectory(invokedScope)
  const id = "b".repeat(32)
  const commands = [
    "list --profile other",
    "list",
    "restart",
    "restart all",
    "cleanup",
    "take-over",
    "send abcd sensitive-message",
    "steer abcd another-message",
    "work list",
    "work find https://github.com/owner/project/issues/17 --profile other",
    "work clear",
    "restore private-name",
    "restore",
    "restore name private-name",
    "restore save private-name",
    "restore list",
    "restore history",
    "restore checkpoint",
    "restore export",
    `restore slot ${id}`,
    `restore from ${id}`,
  ]

  // Act
  for (const command of commands) {
    await ui.command.handler(command, ctx)
  }
  const concurrentListCount = 8
  await Promise.all(
    Array.from({ length: concurrentListCount }, () => ui.command.handler("list --json", ctx))
  )

  // Assert
  const features = [
    "cleanup",
    "list",
    "restart",
    "restore.checkpoint",
    "restore.export",
    "restore.from",
    "restore.history",
    "restore.list",
    "restore.name",
    "restore.save",
    "restore.select",
    "restore.slot",
    "send",
    "steer",
    "take-over",
    "work.clear",
    "work.find",
    "work.list",
  ]
  const files = await readdir(directory)
  assert.deepEqual(
    files.sort(),
    features.map((feature) => `slash.${feature}`)
  )
  for (const feature of features) {
    const counter = path.join(directory, `slash.${feature}`)
    let count = 1
    if (feature === "list") {
      count = 2 + concurrentListCount
    } else if (feature === "restart" || feature === "restore.select") {
      count = 2
    }
    assert.deepEqual(await readFile(counter), Buffer.alloc(count))
    assert.equal((await stat(counter)).mode & 0o777, 0o600)
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  await assert.rejects(access(usageDirectory(otherScope)), {
    code: "ENOENT",
  })
})

test("when the agent directory is relative, slash counters use the process working directory", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  const agentDir = path.join(fixture.root, "launch-agent")
  process.env.PI_CODING_AGENT_DIR = path.relative(process.cwd(), agentDir)
  process.env.OMPI_USAGE = "1"
  const ctx = createContext(fixture.cwd)
  const ui = createCommand(ctx)

  // Act
  await ui.command.handler("restart", ctx)

  // Assert
  const counter = path.join(agentDir, "instance-control", "usage-v1", "slash.restart")
  assert.deepEqual(await readFile(counter), Buffer.from([0]))
})

test("when usage storage contains links, slash commands leave the linked targets untouched", async (t) => {
  // Arrange
  const fixture = await createFixture()
  t.after(() => fixture.close())
  process.env.OMPI_USAGE = "1"
  const ctx = createContext(fixture.cwd)
  const ui = createCommand(ctx)
  const scope = getScope({ cwd: ctx.cwd })
  const directory = usageDirectory(scope)
  const outside = path.join(fixture.root, "outside")
  await mkdir(outside, {
    mode: 0o700,
  })
  await mkdir(path.dirname(directory), {
    recursive: true,
    mode: 0o700,
  })
  await symlink(outside, directory)
  // Act
  await ui.command.handler("list --json", ctx)
  // Assert
  assert.equal(ui.notifications.at(-1).level, "info")
  assert.deepEqual(await readdir(outside), [])

  const privateScope = getScope({
    cwd: ctx.cwd,
    profile: "private",
  })
  process.env.OMP_PROFILE = privateScope.profile
  const privateDirectory = usageDirectory(privateScope)
  await mkdir(privateDirectory, {
    recursive: true,
    mode: 0o700,
  })
  const original = path.join(outside, "original")
  await writeFile(original, "unchanged", {
    mode: 0o600,
  })
  await link(original, path.join(privateDirectory, "slash.list"))
  await symlink(original, path.join(privateDirectory, "slash.cleanup"))

  await ui.command.handler("list --json", ctx)
  assert.equal(ui.notifications.at(-1).level, "info")
  await ui.command.handler("cleanup --json", ctx)
  assert.equal(ui.notifications.at(-1).level, "info")
  assert.equal(await readFile(original, "utf8"), "unchanged")
})
