import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import instanceControl from "../../omp/index.js"
import { getScope } from "../../protocol/index.js"

test("late agent-end metadata cannot recreate an endpoint record during shutdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ic-life-"))
  const launchDirectory = path.join(root, "launch")
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "1".repeat(32)
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    lastRestart: null,
  })
  const environment = {
    XDG_RUNTIME_DIR: root,
    OMP_INSTANCE_CONTROL_LAUNCH_DIR: launchDirectory,
    OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: token,
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
    sessionManager: { getSessionId: () => "persisted-session", getSessionFile: () => null },
    ui: {
      setStatus() {},
      notify(message) {
        assert.fail(message)
      },
    },
  }
  try {
    await instanceControl({
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    })
    await handlers.get("session_start")({}, ctx)
    const transport = await createTransport(scope)
    const closing = handlers.get("session_shutdown")({}, ctx)
    await handlers.get("agent_end")({}, ctx)
    await closing
    assert.deepEqual(await transport.readRecords(), [])
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
