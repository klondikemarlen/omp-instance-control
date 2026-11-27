import { randomBytes } from "node:crypto"
import { accessSync, constants, realpathSync, statSync, writeSync } from "node:fs"
import path from "node:path"

import { PROTOCOL_VERSION } from "../protocol/index.js"
import { writeLaunchHandoff } from "./launcher-context.js"

const EVENT_PREFIX = "omp-instance-control:fresh-launch:"

export function registerFreshLaunch(pi, launch, getRuntime, { processEvents = process } = {}) {
  let request
  const subscriptions = []

  function matchingSession(state, ctx, sessionId) {
    return (
      state &&
      state.launch.token === launch.token &&
      state.launch.scope.id === launch.scope.id &&
      process.ppid === launch.pid &&
      ctx?.agent.kind === "main" &&
      ctx.mode === "tui" &&
      typeof sessionId === "string" &&
      sessionId !== "" &&
      ctx.sessionManager.getSessionId() === sessionId
    )
  }

  function invalidate() {
    request = undefined
  }

  function handle(operation, action) {
    subscriptions.push(
      pi.events.on(EVENT_PREFIX + operation, (envelope) => {
        if (!envelope || typeof envelope !== "object" || envelope.result !== undefined) return

        try {
          const state = getRuntime()
          if (
            !state?.server ||
            state.closing ||
            state.resumingPR ||
            state.exitRequestedSessionId ||
            !matchingSession(state, state.ctx, envelope.sessionId)
          ) {
            throw new Error("Fresh launch requires the attached, active managed main session.")
          }

          envelope.result = action(envelope, state)
        } catch (error) {
          envelope.result = {
            status: "refused",
            message: error.message,
          }
        }
      })
    )
  }

  handle("prepare", ({ sessionId, directory }, state) => {
    if (request) {
      throw new Error("A fresh launch is already prepared for this terminal.")
    }
    if (state.launch.restartError || typeof state.ctx.shutdown !== "function") {
      throw new Error("The current OMP launch cannot safely hand off to a fresh session.")
    }

    validateWrapper(launch)
    const destination = readDestination(directory)
    const ticket = randomBytes(16).toString("hex")
    request = {
      sessionId,
      destination,
      ticket,
      committed: false,
    }
    return {
      status: "accepted",
      ticket,
    }
  })

  function verifyTicket(sessionId, ticket) {
    if (
      !request ||
      request.committed ||
      request.sessionId !== sessionId ||
      request.ticket !== ticket
    ) {
      throw new Error("No matching pending fresh-launch ticket.")
    }
  }

  handle("cancel", ({ sessionId, ticket }) => {
    verifyTicket(sessionId, ticket)
    invalidate()
    return {
      status: "cancelled",
    }
  })

  handle("commit", ({ sessionId, ticket }, state) => {
    verifyTicket(sessionId, ticket)
    const { destination } = request

    try {
      validateWrapper(launch)
      const current = readDestination(destination.directory)
      if (current.device !== destination.device || current.inode !== destination.inode) {
        throw new Error("The approved directory changed after preparation.")
      }

      request.committed = true
      state.ctx.shutdown()
    } catch (error) {
      invalidate()
      throw error
    }

    return {
      status: "committed",
    }
  })

  return {
    invalidate,
    isCommitted: () => request?.committed === true,
    onShutdown(state, ctx) {
      if (!request?.committed || !matchingSession(state, ctx, request.sessionId)) {
        invalidate()
        return
      }

      // A successful native POSIX restart execs without firing the exit event.
      // A drained event loop is not a native explicit exit, either.
      processEvents.once("beforeExit", invalidate)
      processEvents.once("exit", (code) => {
        processEvents.removeListener("beforeExit", invalidate)
        if (code !== 0 || !request || process.ppid !== launch.pid) return

        const { ticket, sessionId, destination } = request
        invalidate()
        try {
          // Keep this record in sync with linux/fresh_launch.go. It is not
          // a resumable session record, and includes no original argv or env.
          writeLaunchHandoff(launch, {
            version: PROTOCOL_VERSION,
            token: launch.token,
            operationId: ticket,
            instanceId: state.instanceId,
            freshLaunch: {
              ...destination,
              sessionId,
              pid: process.pid,
            },
          })
        } catch (error) {
          writeSync(2, `Cannot record fresh ompi launch: ${error.code ?? "write failed"}\n`)
        }
      })
    },
    release() {
      for (const unsubscribe of subscriptions) unsubscribe()
    },
  }
}

function validateWrapper(launch) {
  const wrapper = `/proc/${launch.pid}/exe`
  const installed = realpathSync(wrapper)
  const image = statSync(wrapper, { bigint: true })
  const installedImage = statSync(installed, { bigint: true })
  if (
    !image.isFile() ||
    image.dev !== installedImage.dev ||
    image.ino !== installedImage.ino ||
    (image.mode & 0o6000n) !== 0n ||
    process.getuid() !== process.geteuid() ||
    process.getgid() !== process.getegid()
  ) {
    throw new Error("The running ompi wrapper image is not a usable unprivileged launcher.")
  }
  if (launch.directory.includes(path.delimiter)) {
    throw new Error("The launcher runtime path cannot support a fresh-session settings overlay.")
  }

  accessSync(wrapper, constants.X_OK)
}

function readDestination(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0")) {
    throw new Error("Provide the approved, resolved absolute directory.")
  }
  if (realpathSync(directory) !== directory) {
    throw new Error("The approved directory must be canonical and cannot contain symlinks.")
  }

  const info = statSync(directory, { bigint: true })
  if (!info.isDirectory()) {
    throw new Error("The approved destination is not a directory.")
  }

  accessSync(directory, constants.R_OK | constants.X_OK)
  return {
    directory,
    device: info.dev.toString(),
    inode: info.ino.toString(),
  }
}
