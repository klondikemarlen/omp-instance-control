import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

test("a bin-style symlink runs discovery and returns the empty scoped inventory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ic-cli-"))
  const executable = path.join(root, "bin", "omp-instance-control")
  try {
    await mkdir(path.join(root, "bin"), { mode: 0o700 })
    await symlink(fileURLToPath(new URL("../../cli/index.js", import.meta.url)), executable)
    const result = spawnSync(process.execPath, [executable, "instances", "list", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        PI_CONFIG_DIR: path.join(root, "config"),
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        OMP_PROFILE: "",
        PI_PROFILE: "",
        XDG_RUNTIME_DIR: root,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
