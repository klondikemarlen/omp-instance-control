import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"

const VERSION_MARKER = /^ompi ([0-9A-Za-z][0-9A-Za-z.+-]{0,127})$/u
const PROBE_TIMEOUT_MS = 2_000
const PROBE_MAX_BUFFER = 16 * 1024
const POLL_INTERVAL_MS = 2_000

function validateNativeMetadata(native) {
  if (
    native === null ||
    typeof native !== "object" ||
    typeof native.executable !== "string" ||
    !native.executable.startsWith("/") ||
    typeof native.version !== "string" ||
    !VERSION_MARKER.test(`ompi ${native.version}`) ||
    typeof native.device !== "string" ||
    !/^\d+$/u.test(native.device) ||
    typeof native.inode !== "string" ||
    !/^\d+$/u.test(native.inode)
  ) {
    throw new Error("Native update metadata is invalid.")
  }
}

function fileIdentity(info) {
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    size: info.size.toString(),
    modifiedNs: info.mtimeNs.toString(),
  }
}

function candidateKey(identity) {
  return `${identity.device}:${identity.inode}:${identity.size}:${identity.modifiedNs}`
}

function sameCandidate(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs
  )
}

function sameRunningImage(left, right) {
  return left.device === right.device && left.inode === right.inode
}

async function inspectExecutable(executable) {
  const info = await stat(executable, { bigint: true })
  if (!info.isFile()) {
    throw new Error("Installed ompi is not a regular file.")
  }
  await access(executable, constants.X_OK)
  return fileIdentity(info)
}

async function readInstalledVersion(executable) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["control", "--version"],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        const marker = VERSION_MARKER.exec(stdout.trim())
        if (!marker) {
          reject(new Error("Installed ompi did not report an explicit version marker."))
          return
        }
        resolve(marker[1])
      }
    )
  })
}

export function watchNativeUpdates(native, requestRestart) {
  let status = {
    runningVersion: typeof native?.version === "string" ? native.version : "",
    installedVersion: null,
    state: "checking",
  }
  let closed = false
  let refreshInProgress = null
  const candidateOutcomes = new Map()

  async function refreshOnce() {
    if (closed) return

    let key
    try {
      validateNativeMetadata(native)
      const installedIdentity = await inspectExecutable(native.executable)
      if (closed) return

      if (sameRunningImage(installedIdentity, native)) {
        status = {
          runningVersion: native.version,
          installedVersion: native.version,
          state: "current",
        }
        return
      }

      key = candidateKey(installedIdentity)
      const cachedOutcome = candidateOutcomes.get(key)
      if (cachedOutcome) {
        status = cachedOutcome
        return
      }

      const installedVersion = await readInstalledVersion(native.executable)
      if (closed) return

      const confirmedIdentity = await inspectExecutable(native.executable)
      if (closed) return
      if (!sameCandidate(installedIdentity, confirmedIdentity)) {
        status = {
          runningVersion: native.version,
          installedVersion: null,
          state: "failed",
          message: "Installed ompi changed while its version was being checked.",
        }
        candidateOutcomes.set(key, status)
        return
      }

      const outcome = {
        runningVersion: native.version,
        installedVersion,
        state: "pending",
      }
      candidateOutcomes.set(key, outcome)
      try {
        await requestRestart({
          executable: native.executable,
          runningVersion: native.version,
          installedVersion,
          device: confirmedIdentity.device,
          inode: confirmedIdentity.inode,
          size: confirmedIdentity.size,
          modifiedNs: confirmedIdentity.modifiedNs,
        })
      } catch (error) {
        if (!closed) {
          const rejectedOutcome = {
            runningVersion: native.version,
            installedVersion,
            state: "failed",
            message: `Restart request was rejected: ${error.message}`,
          }
          candidateOutcomes.set(key, rejectedOutcome)
          status = rejectedOutcome
        }
        return
      }
      if (!closed) status = outcome
    } catch (error) {
      if (!closed) {
        const failedOutcome = {
          runningVersion: typeof native?.version === "string" ? native.version : "",
          installedVersion: null,
          state: "failed",
          message: error.message,
        }
        if (key) candidateOutcomes.set(key, failedOutcome)
        status = failedOutcome
      }
    }
  }

  function refresh() {
    if (closed) return Promise.resolve()
    if (!refreshInProgress) {
      refreshInProgress = refreshOnce().finally(() => {
        refreshInProgress = null
      })
    }
    return refreshInProgress
  }

  const timer = setInterval(() => {
    void refresh()
  }, POLL_INTERVAL_MS)
  timer.unref()
  void refresh()

  return {
    refresh,
    getStatus: () => status,
    close() {
      closed = true
      clearInterval(timer)
    },
  }
}

export default watchNativeUpdates
