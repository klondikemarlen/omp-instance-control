import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import instanceControl from "../../omp/index.js"
import { createRequest, getScope } from "../../protocol/index.js"

for (const scenario of [
  {
    name: "ambiguous startup flag arity",
    launch: { restartError: "Ambiguous custom flag; use --custom=value." },
    getFlag: () => undefined,
  },
  {
    name: "extension shadowing a known boolean flag with a string value",
    launch: { flagTypes: { "no-tools": "boolean" } },
    getFlag: () => "literal startup value",
  },
  {
    name: "extension shadowing a known string flag with a boolean value",
    launch: { flagTypes: { plan: "string" } },
    getFlag: () => true,
  },
]) {
  test(`when ${scenario.name} is detected, restart is rejected without requesting shutdown`, async () => {
    // Arrange
    const root = await mkdtemp(path.join(tmpdir(), "ic-argv-"))
    const launchDirectory = path.join(root, "launch")
    const sessionFile = path.join(root, "session.jsonl")
    await mkdir(launchDirectory, { mode: 0o700 })
    await writeFile(sessionFile, "persisted session", { mode: 0o600 })
    const scope = getScope({ env: { HOME: root } })
    const token = "1".repeat(32)
    await writePrivateJson(path.join(launchDirectory, "launch.json"), {
      version: 1,
      token,
      pid: process.ppid,
      scope,
      extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
      lastRestart: null,
      ...scenario.launch,
    })
    const environment = {
      XDG_RUNTIME_DIR: root,
      OMP_INSTANCE_CONTROL_LAUNCH_DIR: launchDirectory,
      OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: token,
      HOME: root,
      PI_CONFIG_DIR: path.join(root, ".omp"),
      PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent"),
      OMP_PROFILE: "",
      PI_PROFILE: "",
    }
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]])
    )
    Object.assign(process.env, environment)
    const handlers = new Map()
    const ctx = {
      agent: { kind: "main" },
      mode: "tui",
      cwd: root,
      sessionManager: {
        getSessionId: () => "persisted-session",
        getSessionFile: () => sessionFile,
      },
      shutdown() {
        assert.fail("A rejected restart must not request host shutdown.")
      },
      ui: {
        setStatus() {},
        notify(message) {
          assert.fail(message)
        },
      },
    }
    let flagsReady = false
    try {
      await instanceControl({
        on(event, handler) {
          handlers.set(event, handler)
        },
        registerCommand() {},
        getFlag: (name) => (flagsReady ? scenario.getFlag(name) : undefined),
      })
      flagsReady = true
      await handlers.get("session_start")({}, ctx)
      const transport = await createTransport(scope)
      const [record] = await transport.readRecords()
      // Act
      const status = await transport.request(record, createRequest(record.instanceId, "status"))
      const result = await transport.request(record, createRequest(record.instanceId, "restart"))

      // Assert
      assert.equal(status.data.canRestart, false)
      assert.equal(result.ok, false)
      assert.equal(result.error.code, "RESTART_ARGUMENTS_UNAVAILABLE")
      assert.equal((await transport.readRecords())[0].state, "running")
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx)
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })
}
