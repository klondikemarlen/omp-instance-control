import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../../", import.meta.url))
const packagingToolsAvailable =
  process.platform === "linux" && spawnSync("dpkg-parsechangelog", ["--version"]).status === 0

async function createFixture() {
  const build = path.join(repository, "build")
  await mkdir(build, { recursive: true })
  const root = await mkdtemp(path.join(build, "package-test-"))
  await mkdir(path.join(root, "bin"))
  await mkdir(path.join(root, "debian"))
  await copyFile(path.join(repository, "bin", "package"), path.join(root, "bin", "package"))
  await chmod(path.join(root, "bin", "package"), 0o755)
  await writeFile(path.join(root, ".gitignore"), "build/\n")
  await writeFile(path.join(root, "payload.txt"), "committed payload\n")
  await writeFile(
    path.join(root, "debian", "changelog"),
    "package-fixture (1.0.0) unstable; urgency=medium\n\n  * Package fixture.\n\n -- Package QA <package-qa@example.invalid>  Wed, 14 Oct 2026 16:30:00 -0700\n"
  )
  execFileSync("git", ["init", "--quiet"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Package QA",
      "-c",
      "user.email=package-qa@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Prepare package fixture.",
    ],
    { cwd: root }
  )
  return root
}

function packageSource(root) {
  return spawnSync(path.join(root, "bin", "package"), [], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  })
}

test(
  "when a source artifact already exists, packaging refuses to replace its bytes",
  { skip: !packagingToolsAvailable },
  async () => {
    // Arrange
    const root = await createFixture()
    try {
      const output = path.join(root, "build", "debian")
      await mkdir(output, { recursive: true })
      const artifact = path.join(output, "package-fixture_1.0.0.dsc")
      await writeFile(artifact, "existing release bytes\n")

      // Act
      const result = packageSource(root)

      // Assert
      assert.equal(result.status, 1)
      assert.equal(await readFile(artifact, "utf8"), "existing release bytes\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test(
  "when tracked source has uncommitted changes, packaging does not produce a stale upload",
  { skip: !packagingToolsAvailable },
  async () => {
    // Arrange
    const root = await createFixture()
    try {
      await writeFile(path.join(root, "payload.txt"), "uncommitted payload\n")

      // Act
      const result = packageSource(root)

      // Assert
      assert.equal(result.status, 1)
      await assert.rejects(
        access(path.join(root, "build", "debian", "package-fixture_1.0.0_source.changes")),
        { code: "ENOENT" }
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
