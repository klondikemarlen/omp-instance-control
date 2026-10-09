import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { launchOmp } from "../../linux/launcher.js"

async function withLauncherFixture(run) {
  const originalCwd = process.cwd()
  const root = await mkdtemp(join(tmpdir(), "instance-launcher-test-"))
  await chmod(root, 0o700)
  const previous = {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    OMP_INSTANCE_CONTROL_OMP: process.env.OMP_INSTANCE_CONTROL_OMP,
    LAUNCH_TEST_LOG: process.env.LAUNCH_TEST_LOG,
  }
  process.env.XDG_RUNTIME_DIR = root
  process.env.LAUNCH_TEST_LOG = join(root, "launches.jsonl")
  try {
    await run(root)
  } finally {
    process.chdir(originalCwd)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function fakeOmp(root, script) {
  const executable = join(root, "fake-omp")
  await writeFile(executable, `#!/usr/bin/env node\n${script}\n`)
  await chmod(executable, 0o700)
  process.env.OMP_INSTANCE_CONTROL_OMP = executable
}

async function launches(root) {
  const log = await readFile(join(root, "launches.jsonl"), "utf8")
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("validated successful handoff resumes exact session and cwd without replaying messages", async () => {
  await withLauncherFixture(async (root) => {
    const sessionFile = join(root, "session.jsonl")
    await writeFile(sessionFile, "persisted session\n")
    await fakeOmp(
      root,
      `
const fs = require('node:fs');
const log = process.env.LAUNCH_TEST_LOG;
const entries = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean) : [];
entries.push(JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  token: JSON.parse(fs.readFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/launch.json', 'utf8')).token
}));
fs.writeFileSync(log, entries.join('\\n') + '\\n');
if (entries.length === 1) {
  const launch = JSON.parse(fs.readFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/launch.json', 'utf8'));
  fs.writeFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/handoff.json', JSON.stringify({
    version: 1,
    token: launch.token,
    operationId: 'restart-request-123',
    instanceId: 'd'.repeat(32),
    sessionFile: ${JSON.stringify(sessionFile)},
    cwd: ${JSON.stringify(root)}
  }), { mode: 0o600 });
}
`
    )

    const result = await launchOmp({
      allowNonTty: true,
      cwd: root,
      profile: "work",
      config: ["one.toml"],
      messages: ["initial message"],
    })
    const runs = await launches(root)
    assert.equal(result, 0)
    assert.equal(runs.length, 2)
    assert.ok(runs[0].argv.includes("initial message"))
    assert.ok(!runs[1].argv.includes("initial message"))
    assert.ok(runs[1].argv.includes("--resume"))
    assert.equal(runs[1].argv[runs[1].argv.indexOf("--resume") + 1], sessionFile)
    assert.equal(runs[1].argv[runs[1].argv.indexOf("--cwd") + 1], root)
    assert.deepEqual(
      runs[1].argv.slice(runs[1].argv.indexOf("--config"), runs[1].argv.indexOf("--config") + 2),
      ["--config", join(root, "one.toml")]
    )
    assert.notEqual(runs[0].token, runs[1].token)
    assert.equal(runs[1].argv.filter((arg) => arg === "--resume").length, 1)
  })
})

test("a handoff cannot override a failed child exit", async () => {
  await withLauncherFixture(async (root) => {
    await fakeOmp(
      root,
      `
const fs = require('node:fs');
const log = process.env.LAUNCH_TEST_LOG;
const launch = JSON.parse(fs.readFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/launch.json', 'utf8'));
fs.appendFileSync(log, JSON.stringify({ token: launch.token }) + '\\n');
fs.writeFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/handoff.json', JSON.stringify({ version: 1, token: launch.token }), { mode: 0o600 });
process.exit(7);
`
    )
    const result = await launchOmp({ allowNonTty: true, cwd: root, messages: ["do not replay"] })
    assert.equal(result, 7)
    assert.equal((await launches(root)).length, 1)
  })
})

test("a handoff for a missing persisted session is not resumed", async () => {
  await withLauncherFixture(async (root) => {
    await fakeOmp(
      root,
      `
const fs = require('node:fs');
const launch = JSON.parse(fs.readFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/launch.json', 'utf8'));
const log = process.env.LAUNCH_TEST_LOG;
fs.appendFileSync(log, JSON.stringify({ token: launch.token }) + '\\n');
fs.writeFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/handoff.json', JSON.stringify({
  version: 1, token: launch.token, operationId: 'restart-request-789',
  instanceId: 'f'.repeat(32), sessionFile: ${JSON.stringify(join(root, "missing-session.jsonl"))},
  cwd: ${JSON.stringify(root)}
}), { mode: 0o600 });
`
    )
    await assert.rejects(launchOmp({ allowNonTty: true, cwd: root }), { code: "ENOENT" })
    assert.equal((await launches(root)).length, 1)
  })
})

test("a handoff from another launch token is rejected", async () => {
  await withLauncherFixture(async (root) => {
    await fakeOmp(
      root,
      `
const fs = require('node:fs');
const launch = JSON.parse(fs.readFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/launch.json', 'utf8'));
fs.appendFileSync(process.env.LAUNCH_TEST_LOG, JSON.stringify({ token: launch.token }) + '\\n');
fs.writeFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/handoff.json', JSON.stringify({
  version: 1, token: 'wrong', operationId: 'restart-request-101',
  instanceId: '1'.repeat(32), sessionFile: '/tmp/not-used', cwd: ${JSON.stringify(root)}
}), { mode: 0o600 });
`
    )
    await assert.rejects(launchOmp({ allowNonTty: true, cwd: root }), /Invalid restart handoff/)
    assert.equal((await launches(root)).length, 1)
  })
})

test("termination signal forwards once and prevents handoff restart", async () => {
  await withLauncherFixture(async (root) => {
    const sessionFile = join(root, "session.jsonl")
    await writeFile(sessionFile, "persisted session\n")
    await fakeOmp(
      root,
      `
const fs = require('node:fs');
const launch = JSON.parse(fs.readFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/launch.json', 'utf8'));
fs.appendFileSync(process.env.LAUNCH_TEST_LOG, JSON.stringify({ token: launch.token }) + '\\n');
fs.writeFileSync(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR + '/handoff.json', JSON.stringify({
  version: 1, token: launch.token, operationId: 'restart-request-456',
  instanceId: 'e'.repeat(32), sessionFile: ${JSON.stringify(sessionFile)}, cwd: ${JSON.stringify(root)}
}), { mode: 0o600 });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`
    )
    const launcherUrl = new URL("../../linux/launcher.js", import.meta.url).href
    const runner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(launcherUrl)}).then(({ launchOmp }) => launchOmp({ allowNonTty: true, cwd: process.cwd() })).then((code) => { process.exitCode = code; });`,
      ],
      { cwd: root, env: process.env, stdio: "ignore" }
    )

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        await readFile(join(root, "launches.jsonl"))
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    assert.ok(Date.now() < deadline, "fake OMP did not start")
    const { promise, resolve, reject } = Promise.withResolvers()
    runner.once("error", reject)
    runner.once("exit", (code, signal) => resolve({ code, signal }))
    runner.kill("SIGTERM")
    const result = await promise
    assert.equal(result.signal, null)
    assert.equal(result.code, 143)
    assert.equal((await launches(root)).length, 1)
  })
})
