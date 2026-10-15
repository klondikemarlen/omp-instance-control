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

test(
  "when completing cleanup options, Bash does not offer restart selection",
  { skip: !bashAvailable },
  () => {
    // Arrange
    const words = ["ompi", "instances", "cleanup", "--a"]

    // Act
    const candidates = complete(words)

    // Assert
    assert.deepEqual(candidates, [])
  }
)

test(
  "when a profile value starts like an action, Bash leaves the value free-form",
  { skip: !bashAvailable },
  () => {
    // Arrange
    const words = ["ompi", "instances", "restart", "--profile", "r"]

    // Act
    const candidates = complete(words)

    // Assert
    assert.deepEqual(candidates, [])
  }
)

test(
  "when an inline profile precedes a restart option, Bash completes the option",
  { skip: !bashAvailable },
  () => {
    // Arrange
    const words = ["ompi", "instances", "restart", "--profile", "=", "work", "--n"]

    // Act
    const candidates = complete(words)

    // Assert
    assert.deepEqual(candidates, ["--no-wait"])
  }
)

test(
  "when the default list profile is named restart, Bash does not change actions",
  { skip: !bashAvailable },
  () => {
    // Arrange
    const words = ["ompi", "instances", "--profile", "restart", "--a"]

    // Act
    const candidates = complete(words)

    // Assert
    assert.deepEqual(candidates, [])
  }
)

test(
  "when the option terminator precedes input, Bash does not offer flags",
  { skip: !bashAvailable },
  () => {
    // Arrange
    const words = ["ompi", "instances", "restart", "--", "--n"]

    // Act
    const candidates = complete(words)

    // Assert
    assert.deepEqual(candidates, [])
  }
)
