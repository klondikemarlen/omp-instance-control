import { randomBytes } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { readNativeTarget, watchNativeUpdates } from "../linux/native-updates.js"
import { captureRecoveryCheckpoint } from "../linux/recovery.js"
import { captureRestoreSnapshot } from "../linux/restore.js"
import { createTransport, readSendContextMetadata } from "../linux/transport.js"
import { getScope, ProtocolError, PROTOCOL_VERSION } from "../protocol/index.js"
import {
  readLauncherContext,
  recordLaunchRegistration,
  writeRestartHandoff,
} from "./launcher-context.js"
import { registerOmpiCommand } from "./command.js"

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

function isOriginContext(state, ctx) {
  if (
    !state.origin ||
    typeof ctx.cwd !== "string" ||
    typeof ctx.sessionManager?.getSessionId !== "function" ||
    typeof ctx.sessionManager?.getSessionFile !== "function"
  ) {
    return false
  }

  try {
    return (
      ctx.cwd === state.origin.cwd &&
      ctx.sessionManager.getSessionId() === state.origin.sessionId &&
      ctx.sessionManager.getSessionFile() === state.origin.sessionFile &&
      state.launch.scope.id === state.origin.scopeId
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

  function rejectRestartAfterExitRequest(state, ctx) {
    if (hasMatchingExitRequest(state, ctx)) {
      throw new ProtocolError("EXPLICIT_EXIT_REQUESTED", "This instance is exiting.")
    }
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
        /[\u0000-\u001f\u007f-\u009f]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
      ctx.ui.notify(`Recovery checkpoint unavailable: ${safeMessage}`, "error")
    }
  }

  async function requestShutdownWhenPersisted(state) {
    if (
      runtime !== state ||
      state.closing ||
      !state.pending ||
      !state.restartAcknowledged ||
      state.shutdownRequested ||
      hasMatchingExitRequest(state, state.ctx)
    ) {
      return
    }

    const initialContext = state.ctx
    if (!isOriginContext(state, initialContext)) return

    let persistence
    try {
      persistence = await sessionPersistence(initialContext)
    } catch (error) {
      state.ctx.ui.notify(
        `Restart is waiting for transcript persistence: ${errorMessage(error)}`,
        "error"
      )
      return
    }
    if (persistence !== "persisted") return

    const ctx = state.ctx
    if (
      runtime !== state ||
      state.closing ||
      state.shutdownRequested ||
      hasMatchingExitRequest(state, ctx) ||
      !isOriginContext(state, ctx) ||
      typeof ctx.shutdown !== "function"
    ) {
      return
    }

    state.shutdownRequested = true
    state.shutdownAccepted = true
    try {
      const result = ctx.shutdown()
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch((error) => {
          state.shutdownAccepted = false
          state.ctx.ui.notify(
            `OMP could not accept graceful shutdown: ${errorMessage(error)}`,
            "error"
          )
        })
      }
    } catch (error) {
      state.shutdownAccepted = false
      state.ctx.ui.notify(`OMP could not accept graceful shutdown: ${errorMessage(error)}`, "error")
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

  async function admitRestart(state, request, ctx) {
    if (request.action === "restart-wrapper") {
      if (request.nativeTarget) {
        state.nativeTarget = request.nativeTarget
      } else {
        const executable = state.launch.native?.executable
        if (!executable) {
          throw new ProtocolError(
            "NATIVE_TARGET_UNAVAILABLE",
            "The installed native ompi executable could not be identified for wrapper restart."
          )
        }
        try {
          state.nativeTarget = await readNativeTarget(executable)
        } catch (error) {
          throw new ProtocolError(
            "NATIVE_TARGET_UNAVAILABLE",
            `The installed native ompi executable could not be verified: ${errorMessage(error)}`
          )
        }
      }
    }
    await refresh(ctx)
  }

  async function handleRequest(request) {
    if (runtime.closing) {
      throw new ProtocolError("INSTANCE_CLOSING", "This instance is shutting down.")
    }

    const state = runtime
    const ctx = state.ctx
    if (request.action === "status") {
      const currentRecord = record(ctx)
      const apiUnavailable = restartApiError(ctx) !== null
      const [sendContext, persistence] = await Promise.all([
        readSendContextMetadata(currentRecord),
        sessionPersistence(ctx),
      ])
      return {
        data: {
          ...currentRecord,
          canRestart:
            !hasMatchingExitRequest(state, ctx) &&
            !state.launch.restartError &&
            !apiUnavailable &&
            persistence === "persisted",
          sendContext,
          native: state.nativeUpdates?.getStatus() ?? null,
        },
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

    const persistence = await sessionPersistence(ctx)
    if (persistence === "unavailable") {
      throw new ProtocolError(
        "SESSION_UNAVAILABLE",
        "Restart requires a persistent transcript path to a regular file; ephemeral sessions cannot be resumed."
      )
    }
    rejectRestartAfterExitRequest(state, ctx)
    if (state.pending && !isOriginContext(state, ctx)) {
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
      state.origin = {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        scopeId: state.launch.scope.id,
      }
      state.admission = admitRestart(state, request, ctx)
    }

    const admission = state.admission
    try {
      await admission
    } catch (error) {
      if (state.admission === admission) {
        state.pending = null
        state.pendingAction = null
        state.nativeTarget = null
        state.origin = undefined
        state.restartAcknowledged = false
        state.shutdownRequested = false
        state.shutdownAccepted = false
        state.admission = undefined
        void state.transport.writeRecord(record(state.ctx)).catch(() => {})
      }
      throw error
    }

    if (hasMatchingExitRequest(state, ctx)) {
      if (firstRequest && state.admission === admission && state.pending === request.requestId) {
        state.pending = null
        state.pendingAction = null
        state.nativeTarget = null
        state.origin = undefined
        state.restartAcknowledged = false
        state.shutdownRequested = false
        state.shutdownAccepted = false
        state.admission = undefined
        void state.transport.writeRecord(record(state.ctx)).catch(() => {})
      }
      rejectRestartAfterExitRequest(state, ctx)
    }

    return {
      data: {
        state: "accepted",
        operationId: state.pending,
        message: "Restart accepted; OMP owns settlement of active and queued work.",
      },
      afterReply: async () => {
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

      await recordLaunchRegistration(launch, scope, runtime.instanceId)
      runtime.server = await runtime.transport.serve(runtime.instanceId, handleRequest, (error) =>
        ctx.ui.notify(`Instance control: ${error.message}`, "error")
      )
      await refresh(ctx)
      await refreshCompletions(ctx)
      ctx.ui.setStatus("instance-control", `instance ${runtime.instanceId.slice(0, 8)}`)

      const state = runtime
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
          if (
            state.pending &&
            state.shutdownAccepted &&
            isOriginContext(state, ctx) &&
            !hasMatchingExitRequest(state, ctx)
          ) {
            const persistence = await sessionPersistence(ctx)
            if (
              persistence === "persisted" &&
              state.shutdownAccepted &&
              isOriginContext(state, ctx) &&
              !hasMatchingExitRequest(state, ctx)
            ) {
              writeRestartHandoff(state.launch, state.pending, state.instanceId, ctx, {
                restartWrapper: state.pendingAction === "restart-wrapper",
                nativeTarget: state.nativeTarget,
              })
            }
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
