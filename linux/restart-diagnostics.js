import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

// Keep the marker and snapshot formats in sync with restart_diagnostics.go.
const OBSERVATION_MARKER = "restart-observation.json"
const ONLINE_MARKER = "restart-online.json"
const CANONICAL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

export function recordRestartShutdownRequested(launch, requestId, previousInstanceId) {
  const identity = restartIdentity(requestId, previousInstanceId)
  if (!identity) return

  recordObservation(launch.scope, identity, "shutdown-requested")
  writePrivateMarker(launch, OBSERVATION_MARKER, identity)
}

export function recordRestartShutdownRejected(launch, requestId, previousInstanceId) {
  const identity = restartIdentity(requestId, previousInstanceId)
  if (!identity) return

  recordObservation(launch.scope, identity, "shutdown-rejected", "shutdown-rejected")
}

export function recordRestartSuppressed(launch, requestId, previousInstanceId) {
  const identity = restartIdentity(requestId, previousInstanceId)
  if (!identity) return

  recordObservation(launch.scope, identity, "restart-suppressed")
  clearRestartObservation(launch)
}

export function clearRestartObservation(launch) {
  try {
    ensurePrivateDirectory(launch.directory, { create: false })
    unlinkSync(path.join(launch.directory, OBSERVATION_MARKER))
  } catch {
    // Missing or unavailable diagnostic state never changes the launch outcome.
  }
}

export function recordReplacementOnline(launch) {
  if (!launch.lastRestart) return

  const { operationId, previousInstanceId } = launch.lastRestart
  const identity = restartIdentity(operationId, previousInstanceId)
  if (!identity) return

  try {
    ensurePrivateDirectory(launch.directory, { create: false })
    // The wrapper clears this marker for each child. An in-place OMP reload
    // is not a new replacement and must not overwrite a later bucket entry.
    if (privateFileExists(path.join(launch.directory, ONLINE_MARKER))) return
  } catch {
    // Still attempt the independently scoped snapshot.
  }

  recordObservation(launch.scope, identity, "replacement-online")
  writePrivateMarker(launch, ONLINE_MARKER, identity)
}

function restartIdentity(requestId, previousInstanceId) {
  if (
    typeof previousInstanceId !== "string" ||
    previousInstanceId.length !== 32 ||
    !/^[0-9a-f]{32}$/.test(previousInstanceId) ||
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > 128
  ) {
    return null
  }

  let operationId = requestId
  if (requestId.length !== 36 || !CANONICAL_UUID.test(requestId)) {
    operationId = createHash("sha256").update(requestId, "utf8").digest("hex")
  }

  return {
    operationId,
    previousInstanceId,
  }
}

function recordObservation(scope, identity, stage, error) {
  try {
    const directory = path.join(scope.agentDir, "instance-control", "restart-diagnostics-v1")
    const bucket = identity.previousInstanceId.slice(0, 2)
    const observedAt = new Date().toISOString()
    ensurePrivateDirectory(directory, { create: true })
    writePrivateJson(path.join(directory, `${bucket}.json`), {
      ...identity,
      stage,
      observedAt,
      error,
    })
  } catch {
    // Diagnostics are best effort, not a prerequisite for graceful shutdown.
  }
}

function writePrivateMarker(launch, filename, identity) {
  try {
    ensurePrivateDirectory(launch.directory, { create: false })
    writePrivateJson(path.join(launch.directory, filename), identity)
  } catch {
    // A marker correlates observations but is never required for a restart.
  }
}

// Synchronous counterpart to the private path rules in transport.js: yielding
// here would let a context switch or explicit exit race the final shutdown gate.
function ensurePrivateDirectory(directory, { create }) {
  if (!path.isAbsolute(directory)) {
    throw new Error("Restart diagnostics require an absolute directory")
  }

  const absolute = path.resolve(directory)
  let current = path.parse(absolute).root
  for (const component of absolute.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      if (!create || error.code !== "ENOENT") throw error

      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (creationError) {
        if (creationError.code !== "EEXIST") throw creationError
      }
      info = lstatSync(current)
    }

    if (!info.isDirectory()) {
      throw new Error("Restart diagnostics require real directories")
    }
    if (current === absolute) {
      if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
        throw new Error("Restart diagnostics require a private directory")
      }
    } else {
      const trustedOwner = info.uid === 0 || info.uid === process.getuid()
      const stickyTmp = current === "/tmp" && info.uid === 0 && (info.mode & 0o1000) !== 0
      if (!trustedOwner || ((info.mode & 0o022) !== 0 && !stickyTmp)) {
        throw new Error("Restart diagnostics require trusted directories")
      }
    }
  }
}

function privateFileExists(file) {
  let info
  try {
    info = lstatSync(file)
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }

  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("Restart diagnostics require a private regular file")
  }
  return true
}

function writePrivateJson(file, value) {
  privateFileExists(file)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const descriptor = openSync(temporary, flags, 0o600)
  try {
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8")
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    privateFileExists(file)
    renameSync(temporary, file)
  } catch (error) {
    unlinkSync(temporary)
    throw error
  }
}
