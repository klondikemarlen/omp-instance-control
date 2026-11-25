import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { readNativeTarget, watchNativeUpdates } from "../linux/native-updates.js"
import { captureRecoveryCheckpoint } from "../linux/recovery.js"
import {
  clearRestartObservation,
  recordReplacementOnline,
  recordRestartShutdownRejected,
  recordRestartShutdownRequested,
  recordRestartSuppressed,
} from "../linux/restart-diagnostics.js"
import { captureRestoreSnapshot } from "../linux/restore.js"
import { createTransport, readSendContextMetadata } from "../linux/transport.js"
import { getScope, ProtocolError, PROTOCOL_VERSION } from "../protocol/index.js"
import {
  readLauncherContext,
  recordLaunchRegistration,
  writeRestartHandoff,
} from "./launcher-context.js"
import { registerOmpiCommand } from "./command.js"
import { registerPeerMessageRenderer } from "./peer-message.js"

const ENTRY_CLAIM_EVENT = "omp-instance-control:entry-claim"
const EXIT_REQUESTED_EVENT = "omp-exit-command:exit-requested"

function isMainTerminal(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui"
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function restartApiError(ctx) {
  const sessionManager = ctx.sessionManager
  if (
    !isMainTerminal(ctx) ||
    typeof ctx.cwd !== "string" ||
    typeof ctx.shutdown !== "function" ||
    typeof sessionManager?.getSessionId !== "function" ||
    typeof sessionManager?.getSessionFile !== "function"
  ) {
    return "OMP's public session and graceful-shutdown APIs are unavailable."
  }
  return null
}

function messageApiError(pi) {
  if (typeof pi.sendMessage !== "function") {
    return "OMP's public custom-message API is unavailable."
  }
  return null
}

function readSessionTitle(pi) {
  let sessionTitle
  try {
    sessionTitle = pi.getSessionName?.()
  } catch {
    return null
  }

  if (typeof sessionTitle !== "string" || !/\P{White_Space}/u.test(sessionTitle)) {
    return null
  }
  return sessionTitle
}

async function sessionPersistence(ctx) {
  const getSessionFile = ctx.sessionManager?.getSessionFile
  if (typeof getSessionFile !== "function") return "unavailable"

  let sessionFile
  try {
    sessionFile = getSessionFile.call(ctx.sessionManager)
  } catch {
    return "unavailable"
  }
  if (typeof sessionFile !== "string" || sessionFile.length === 0) return "unavailable"

  try {
    return (await stat(sessionFile)).isFile() ? "persisted" : "unavailable"
  } catch (error) {
    if (error.code === "ENOENT") return "unmaterialized"
    throw error
  }
}

async function restartDirectoryError(ctx) {
  try {
    if (!(await stat(ctx.cwd)).isDirectory()) {
      return "The restart working directory is not a directory."
    }
    await access(ctx.cwd, constants.X_OK)
    return null
  } catch (error) {
    return `The restart working directory is unavailable: ${errorMessage(error)}`
  }
}

async function readInstalledNativeTarget(launch, expectedTarget) {
  const executable = launch.native?.executable
  if (typeof executable !== "string" || !executable.startsWith("/")) {
    throw new ProtocolError(
      "NATIVE_TARGET_UNAVAILABLE",
      "The original installed ompi path could not be identified for wrapper restart."
    )
  }

  let installedTarget
  try {
    installedTarget = await readNativeTarget(executable)
  } catch (error) {
    throw new ProtocolError(
      "NATIVE_TARGET_UNAVAILABLE",
      `The installed native ompi executable could not be verified: ${errorMessage(error)}`
    )
  }

  if (
    expectedTarget &&
    (installedTarget.device !== expectedTarget.device ||
      installedTarget.inode !== expectedTarget.inode ||
      installedTarget.size !== expectedTarget.size ||
      installedTarget.modifiedNs !== expectedTarget.modifiedNs)
  ) {
    throw new ProtocolError(
      "NATIVE_TARGET_CHANGED",
      "The installed native ompi executable no longer matches the requested image."
    )
  }

  return installedTarget
}

function isOriginContext(state, ctx, origin = state.origin) {
  if (
    !origin ||
    typeof ctx.cwd !== "string" ||
    typeof ctx.sessionManager?.getSessionId !== "function" ||
    typeof ctx.sessionManager?.getSessionFile !== "function"
  ) {
    return false
  }

  try {
    return (
      ctx.cwd === origin.cwd &&
      ctx.sessionManager.getSessionId() === origin.sessionId &&
      ctx.sessionManager.getSessionFile() === origin.sessionFile &&
      state.launch.scope.id === origin.scopeId
    )
  } catch {
    return false
  }
}

export default async function instanceControl(pi) {
  const launch = await readLauncherContext()
  if (
    launch &&
    (await realpath(launch.extensionPath)) !== (await realpath(fileURLToPath(import.meta.url)))
  ) {
    return
  }

  const claimProbe = { claimed: false }
  pi.events.emit(ENTRY_CLAIM_EVENT, claimProbe)
  if (claimProbe.claimed) return

  const releaseClaim = pi.events.on(ENTRY_CLAIM_EVENT, (probe) => {
    if (probe && typeof probe === "object") probe.claimed = true
  })

  if (launch) clearRestartObservation(launch)

  registerPeerMessageRenderer(pi)

  let runtime
  const refreshCompletions = registerOmpiCommand(pi, { getRuntime: () => runtime })
  const releaseExitRequestListener = pi.events.on(EXIT_REQUESTED_EVENT, (request) => {
    if (!runtime || !isMainTerminal(runtime.ctx) || typeof request?.sessionId !== "string") return

    const getSessionId = runtime.ctx.sessionManager?.getSessionId
    if (typeof getSessionId !== "function") return

    let activeSessionId
    try {
      activeSessionId = getSessionId.call(runtime.ctx.sessionManager)
    } catch {
      return
    }
    if (request.sessionId !== activeSessionId && request.sessionId !== runtime.origin?.sessionId) {
      return
    }

    runtime.exitRequestedSessionId = request.sessionId
    runtime.nativeUpdates?.close()
    // Only an origin-session exit keeps matching even if the active session changes.
    if (request.sessionId === runtime.origin?.sessionId) {
      suppressRestart(runtime)
    }
  })

  function hasMatchingExitRequest(state, ctx) {
    if (typeof state.exitRequestedSessionId !== "string") return false
    try {
      return (
        state.exitRequestedSessionId === ctx.sessionManager.getSessionId() ||
        state.exitRequestedSessionId === state.origin?.sessionId
      )
    } catch {
      return false
    }
  }

  function assertRestartContext(state, origin) {
    if (runtime !== state || state.closing) {
      throw new ProtocolError("INSTANCE_CLOSING", "This instance is shutting down.")
    }

    if (hasMatchingExitRequest(state, state.ctx)) {
      throw new ProtocolError("EXPLICIT_EXIT_REQUESTED", "This instance is exiting.")
    }

    if (process.ppid !== state.launch.pid) {
      throw new ProtocolError("LAUNCHER_GONE", "The owning launcher is no longer attached.")
    }

    if (!isOriginContext(state, state.ctx, origin)) {
      throw new ProtocolError(
        "RESTART_CONTEXT_CHANGED",
        "The session, transcript, working directory, or launch scope changed."
      )
    }
  }

  function suppressRestart(state) {
    if (!state.pending || !state.shutdownAccepted || state.restartSuppressed) return

    state.restartSuppressed = true
    recordRestartSuppressed(state.launch, state.pending, state.instanceId)
  }

  function record(ctx) {
    return {
      version: PROTOCOL_VERSION,
      instanceId: runtime.instanceId,
      scope: runtime.launch.scope.id,
      pid: process.pid,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      launcherManaged: true,
      state: runtime.pending ? "restart-requested" : "running",
      operationId: runtime.pending ?? null,
      lastRestart: runtime.launch.lastRestart ?? null,
      ...(runtime.launch.restoreId ? { restoreId: runtime.launch.restoreId } : {}),
    }
  }

  async function writeRestoreSnapshot(state, ctx, { excludeRestoreId } = {}) {
    if (!state.launch.restoreId) return

    try {
      await captureRestoreSnapshot(state.launch.scope, state.launch, ctx)
      await captureRecoveryCheckpoint(state.launch.scope, {
        reason: "automatic",
        excludeRestoreId,
      })
    } catch (error) {
      const safeMessage = errorMessage(error).replace(
        // eslint-disable-next-line no-control-regex -- Escape untrusted terminal control bytes.
        /[\u0000-\u001f\u007f-\u009f]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
      ctx.ui.notify(`Recovery checkpoint unavailable: ${safeMessage}`, "error")
    }
  }

  function clearPendingRestart(state) {
    state.pending = null
    state.pendingAction = null
    state.nativeTarget = null
    state.origin = undefined
    state.restartAcknowledged = false
    state.shutdownRequested = false
    state.shutdownAccepted = false
    state.admission = undefined
    if (runtime === state && !state.closing) {
      refresh(state.ctx).catch(() => {})
    }
  }

  async function requestShutdownWhenPersisted(state) {
    const operationId = state.pending

    function verifyShutdownContext() {
      if (
        runtime !== state ||
        state.closing ||
        !operationId ||
        state.pending !== operationId ||
        !state.restartAcknowledged ||
        state.shutdownRequested ||
        hasMatchingExitRequest(state, state.ctx)
      ) {
        return false
      }

      if (!isOriginContext(state, state.ctx)) {
        state.ctx.ui.notify(
          "Restart is waiting for the original session, transcript, and working directory.",
          "info"
        )
        return false
      }

      if (process.ppid !== state.launch.pid) {
        state.ctx.ui.notify("Cannot restart: the owning launcher is no longer attached.", "error")
        return false
      }

      if (typeof state.ctx.shutdown !== "function") {
        state.ctx.ui.notify("Restart is waiting for OMP's graceful-shutdown API.", "error")
        return false
      }

      return true
    }

    if (!verifyShutdownContext()) return

    let persistence
    try {
      persistence = await sessionPersistence(state.ctx)
    } catch (error) {
      if (!verifyShutdownContext()) return

      state.ctx.ui.notify(
        `Restart is waiting for transcript persistence: ${errorMessage(error)}`,
        "error"
      )
      return
    }

    if (!verifyShutdownContext()) return

    if (persistence !== "persisted") return

    const directoryError = await restartDirectoryError(state.ctx)
    if (!verifyShutdownContext()) return

    if (directoryError) {
      state.ctx.ui.notify(`Restart is waiting: ${directoryError}`, "error")
      return
    }

    if (state.pendingAction === "restart-wrapper") {
      try {
        await readInstalledNativeTarget(state.launch, state.nativeTarget)
      } catch (error) {
        if (!verifyShutdownContext()) return

        state.refusedRestartOperationId = operationId
        clearPendingRestart(state)
        state.ctx.ui.notify(
          `Restart canceled; OMP is still open. ${errorMessage(error)} Retry when ready.`,
          "error"
        )
        return
      }

      if (!verifyShutdownContext()) return
    }

    const ctx = state.ctx
    function rejectShutdown(error) {
      state.shutdownAccepted = false
      if (!state.restartSuppressed) {
        recordRestartShutdownRejected(state.launch, operationId, state.instanceId)
        if (runtime === state && state.pending === operationId) {
          clearRestartObservation(state.launch)
        }
      }
      state.ctx.ui.notify(`OMP could not accept graceful shutdown: ${errorMessage(error)}`, "error")
    }

    state.shutdownRequested = true
    state.shutdownAccepted = true
    recordRestartShutdownRequested(state.launch, operationId, state.instanceId)
    try {
      const result = ctx.shutdown()
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(rejectShutdown)
      }
    } catch (error) {
      rejectShutdown(error)
    }
  }

  async function refresh(ctx) {
    if (!runtime || runtime.closing || !isMainTerminal(ctx)) return
    const state = runtime
    state.ctx = ctx

    const previousWrite = state.recordWrite ?? Promise.resolve()
    state.recordWrite = previousWrite
      .catch(() => {})
      .then(async () => {
        const activeContext = state.ctx
        try {
          await state.transport.writeRecord(record(activeContext))
        } finally {
          await writeRestoreSnapshot(state, activeContext)
        }
      })
    await state.recordWrite

    try {
      await requestShutdownWhenPersisted(state)
    } catch (error) {
      state.ctx.ui.notify(`Restart shutdown request failed: ${errorMessage(error)}`, "error")
    }
  }

  async function admitRestart(state, request, origin) {
    if (request.action === "restart-wrapper") {
      const installedTarget = await readInstalledNativeTarget(state.launch, request.nativeTarget)
      assertRestartContext(state, origin)

      if (request.nativeTarget) {
        state.nativeTarget = request.nativeTarget
      } else if (state.launch.supportsInstalledWrapperSelection !== true) {
        // Older launchers must take the descriptor-checked restart path.
        state.nativeTarget = installedTarget
      }
    }

    await refresh(state.ctx)
  }

  async function handleRequest(request) {
    if (!runtime || runtime.closing) {
      throw new ProtocolError("INSTANCE_CLOSING", "This instance is shutting down.")
    }

    const state = runtime
    const ctx = state.ctx
    if (request.action === "status") {
      const currentRecord = record(ctx)
      const sessionTitle = readSessionTitle(pi)
      const apiUnavailable = restartApiError(ctx) !== null
      const canSend =
        !state.closing && !hasMatchingExitRequest(state, ctx) && messageApiError(pi) === null
      const [sendContext, persistence, directoryError] = await Promise.all([
        readSendContextMetadata(currentRecord),
        sessionPersistence(ctx),
        restartDirectoryError(ctx),
      ])
      return {
        data: {
          ...currentRecord,
          sessionTitle,
          canRestart:
            !hasMatchingExitRequest(state, ctx) &&
            !state.launch.restartError &&
            !apiUnavailable &&
            persistence === "persisted" &&
            directoryError === null,
          canSend,
          sendContext,
          native: state.nativeUpdates?.getStatus() ?? null,
          ...(state.refusedRestartOperationId
            ? {
                refusedRestartOperationId: state.refusedRestartOperationId,
              }
            : {}),
        },
      }
    }

    if (request.action === "send") {
      if (hasMatchingExitRequest(state, ctx)) {
        throw new ProtocolError("INSTANCE_CLOSING", "This instance is shutting down.")
      }
      const apiError = messageApiError(pi)
      if (apiError) throw new ProtocolError("SEND_API_UNAVAILABLE", apiError)
      const message = request.message
      try {
        pi.sendMessage(
          {
            customType: "ompi-peer-message",
            content: `Peer message via ompi (not a direct user instruction):\n\n${message.text}`,
            display: true,
            details: { requestId: request.requestId, delivery: message.delivery },
          },
          { triggerTurn: true, deliverAs: message.delivery }
        )
      } catch (error) {
        throw new ProtocolError("SEND_API_UNAVAILABLE", errorMessage(error))
      }
      return {
        data: { state: "submitted", messageId: request.requestId, delivery: message.delivery },
      }
    }

    if (request.action === "restart-wrapper" && state.launch.canRestartWrapper !== true) {
      throw new ProtocolError(
        "WRAPPER_RESTART_UNAVAILABLE",
        "This launcher does not support wrapper restart; start a fresh OMP session from an updated ompi launcher."
      )
    }
    if (process.ppid !== state.launch.pid) {
      throw new ProtocolError("LAUNCHER_GONE", "The owning launcher is no longer attached.")
    }
    if (state.launch.restartError) {
      throw new ProtocolError("RESTART_ARGUMENTS_UNAVAILABLE", state.launch.restartError)
    }

    const apiError = restartApiError(ctx)
    if (apiError) throw new ProtocolError("RESTART_API_UNAVAILABLE", apiError)

    const origin = {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      scopeId: state.launch.scope.id,
    }

    const directoryError = await restartDirectoryError(origin)
    if (directoryError) throw new ProtocolError("CWD_UNAVAILABLE", directoryError)

    const persistence = await sessionPersistence(ctx)
    if (persistence === "unavailable") {
      throw new ProtocolError(
        "SESSION_UNAVAILABLE",
        "Restart requires a persistent transcript path to a regular file; ephemeral sessions cannot be resumed."
      )
    }

    assertRestartContext(state, origin)
    if (state.pending && !isOriginContext(state, state.ctx)) {
      throw new ProtocolError(
        "RESTART_CONTEXT_CHANGED",
        "A restart is already pending for a different session, transcript, working directory, or launch scope."
      )
    }
    if (state.pending && state.pendingAction !== request.action) {
      throw new ProtocolError(
        "RESTART_ALREADY_PENDING",
        "A different restart operation is already pending for this instance."
      )
    }

    const firstRequest = !state.pending
    if (firstRequest) {
      state.restartAcknowledged = false
      state.shutdownRequested = false
      state.shutdownAccepted = false
      state.pending = request.requestId
      state.pendingAction = request.action
      state.nativeTarget = null
      state.origin = origin
      state.admission = admitRestart(state, request, origin)
    }

    const operationId = state.pending
    const admission = state.admission
    try {
      await admission
      assertRestartContext(state, origin)
    } catch (error) {
      if (state.admission === admission && !state.restartAcknowledged) {
        clearPendingRestart(state)
      }
      throw error
    }

    if (state.pending !== operationId) {
      throw new ProtocolError("RESTART_CANCELED", "Restart was canceled before acknowledgement.")
    }

    return {
      data: {
        state: "accepted",
        operationId,
        message: "Restart accepted; OMP owns settlement of active and queued work.",
      },
      afterReply: async () => {
        if (runtime !== state || state.closing || state.pending !== operationId) return

        state.restartAcknowledged = true
        await requestShutdownWhenPersisted(state)
      },
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isMainTerminal(ctx)) return
    await refreshCompletions(ctx)
    if (runtime) return

    try {
      if (!launch) {
        ctx.ui.setStatus(
          "instance-control",
          "peer control only; this session is not launcher-managed"
        )
        return
      }

      // This read-only boundary is the documented parsed-flag compatibility decision.
      const flagValues = pi.runtime?.flagValues
      if (!(flagValues instanceof Map)) {
        launch.restartError =
          "OMP's parsed extension flags are unavailable; controlled restart is disabled, but normal OMP invocation is unchanged."
      } else {
        const shadow = launch.builtinFlags.find((name) => flagValues.has(name))
        if (shadow) {
          launch.restartError = `Extension flag --${shadow} overrides a built-in OMP option used by this launch; controlled restart is disabled to prevent changed arguments or startup-message replay.`
        }
      }

      const scope = getScope({ cwd: ctx.cwd })
      runtime = {
        launch: { ...launch, scope },
        transport: await createTransport(scope),
        ctx,
        instanceId: randomBytes(16).toString("hex"),
        pending: null,
        pendingAction: null,
        origin: {
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile(),
          cwd: ctx.cwd,
          scopeId: scope.id,
        },
      }

      const state = runtime
      await recordLaunchRegistration(launch, scope, state.instanceId)
      state.server = await state.transport.serve(state.instanceId, handleRequest, (error) =>
        ctx.ui.notify(`Instance control: ${error.message}`, "error")
      )
      await refresh(ctx)
      if (runtime === state && !state.closing) {
        recordReplacementOnline(state.launch)
      }
      await refreshCompletions(ctx)
      ctx.ui.setStatus("instance-control", `instance ${runtime.instanceId.slice(0, 8)}`)

      if (state.launch.native && state.launch.canRestartWrapper === true) {
        state.nativeUpdates = watchNativeUpdates(state.launch.native, (candidate) => {
          if (runtime !== state || state.closing || hasMatchingExitRequest(state, state.ctx)) return
          state.ctx.ui.notify(
            `Installed native ompi ${candidate.installedVersion} detected; run /ompi restart to apply.`,
            "info"
          )
        })
      }
    } catch (error) {
      if (runtime) {
        runtime.nativeUpdates?.close()
        await runtime.server?.close()
        await runtime.transport.removeRecord(runtime.instanceId)
        runtime = undefined
      }
      ctx.ui.notify(`Instance control unavailable: ${error.message}`, "error")
    }
  })

  pi.on("session_switch", async (_event, ctx) => {
    await refresh(ctx)
    if (isMainTerminal(ctx)) await refreshCompletions(ctx)
  })
  pi.on("session_branch", async (_event, ctx) => {
    await refresh(ctx)
    if (isMainTerminal(ctx)) await refreshCompletions(ctx)
  })
  pi.on("agent_end", async (_event, ctx) => {
    await refresh(ctx)
    if (isMainTerminal(ctx)) await refreshCompletions(ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return
    if (runtime) {
      try {
        const state = runtime
        if (isMainTerminal(ctx)) {
          state.closing = true
          state.nativeUpdates?.close()
          if (!state.pending || !state.shutdownAccepted) return

          if (!isOriginContext(state, ctx) || hasMatchingExitRequest(state, ctx)) {
            suppressRestart(state)
            return
          }

          const persistence = await sessionPersistence(ctx)
          if (!state.shutdownAccepted) return

          if (!isOriginContext(state, ctx) || hasMatchingExitRequest(state, ctx)) {
            suppressRestart(state)
            return
          }

          if (persistence === "persisted") {
            writeRestartHandoff(state.launch, state.pending, state.instanceId, ctx, {
              restartWrapper: state.pendingAction === "restart-wrapper",
              nativeTarget: state.nativeTarget,
            })
          }
        }
      } finally {
        if (runtime && isMainTerminal(ctx)) {
          const state = runtime
          const previousWrite = state.recordWrite ?? Promise.resolve()
          state.recordWrite = previousWrite
            .catch(() => {})
            .then(() =>
              writeRestoreSnapshot(state, ctx, { excludeRestoreId: state.launch.restoreId })
            )
          await state.recordWrite
          await state.server.close()
          await state.transport.removeRecord(state.instanceId)
          runtime = undefined
        }
        releaseClaim()
        releaseExitRequestListener()
      }
    } else {
      releaseClaim()
      releaseExitRequestListener()
    }
  })
}
