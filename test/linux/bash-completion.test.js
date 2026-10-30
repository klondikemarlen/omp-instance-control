import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const completion = fileURLToPath(new URL("../../linux/bash-completion/ompi", import.meta.url))
const framework = "/usr/share/bash-completion/bash_completion"
const bashAvailable = process.platform === "linux" && existsSync(framework)

function complete(words) {
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      [
        'source "$1"',
        'source "$2"',
        "shift 2",
        'COMP_WORDS=("$@")',
        "COMP_CWORD=$(( $# - 1 ))",
        'COMP_LINE="${COMP_WORDS[*]}"',
        "COMP_POINT=${#COMP_LINE}",
        "_ompi",
        'printf "%s\\n" "${COMPREPLY[@]}"',
      ].join("\n"),
      "bash-completion-test",
      framework,
      completion,
      ...words,
    ],
    { encoding: "utf8" }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || `Bash exited with ${result.status}`)
  }

  return result.stdout.trim().split("\n").filter(Boolean)
}

for (const { condition, words, expected } of [
  {
    condition: "a restart target is selected",
    words: ["ompi", "control", "restart", "all", ""],
    expected: [],
  },
  {
    condition: "a JSON option has already been consumed",
    words: ["ompi", "control", "restart", "all", "--json=true", "--"],
    expected: ["--profile", "--no-wait"],
  },
  {
    condition: "a profile value equals the all target word",
    words: ["ompi", "control", "restart", "--profile", "all", "a"],
    expected: ["all"],
  },
  {
    condition: "a profile value is pending",
    words: ["ompi", "control", "restart", "all", "--profile", "--j"],
    expected: [],
  },
  {
    condition: "a profile was supplied inline",
    words: ["ompi", "control", "restart", "all", "--profile=work", "--"],
    expected: ["--json", "--no-wait"],
  },
  {
    condition: "the end-of-options delimiter is complete",
    words: ["ompi", "control", "restart", "all", "--", "--n"],
    expected: [],
  },
  {
    condition: "cleanup is selected",
    words: ["ompi", "control", "cleanup", "--n"],
    expected: [],
  },
  {
    condition: "a checkpoint operation is selected",
    words: ["ompi", "control", "restore", "checkpoint", "--"],
    expected: ["--profile"],
  },
  {
    condition: "recovery listing already consumes JSON",
    words: ["ompi", "control", "restore", "list", "--json", "--"],
    expected: ["--from", "--profile"],
  },
  {
    condition: "a recovery operation is complete",
    words: ["ompi", "control", "restore", "checkpoint", ""],
    expected: [],
  },
]) {
  test(
    `when ${condition}, completion offers only valid next choices`,
    { skip: !bashAvailable },
    () => {
      // Arrange
      const input = words

      // Act
      const candidates = complete(input)

      // Assert
      assert.deepEqual(candidates, expected)
    }
  )
}
