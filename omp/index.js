import { randomBytes } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { watchNativeUpdates } from "../linux/native-updates.js"
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
import { requestWrapperRestart } from "./restart.js"

const ENTRY_CLAIM_EVENT = "omp-instance-control:entry-claim"
const EXIT_REQUESTED_EVENT = "omp-exit-command:exit-requested"

function isMainTerminal(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui"
}

async function sessionPersistence(ctx) {
  const file = ctx.sessionManager.getSessionFile()
  if (!file) return "unavailable"

  try {
    return (await stat(file)).isFile() ? "persisted" : "unavailable"
  } catch (error) {
    if (error.code === "ENOENT") return "unmaterialized"

    throw error
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
  if (claimProbe.claimed) {
    return
  }
  const releaseClaim = pi.events.on(ENTRY_CLAIM_EVENT, (probe) => {
    if (probe && typeof probe === "object") {
      probe.claimed = true
    }
  })

  let runtime
  const refreshCompletions = registerOmpiCommand(pi, { getRuntime: () => runtime })
  const releaseExitRequestListener = pi.events.on(EXIT_REQUESTED_EVENT, (request) => {
    if (
      !runtime ||
      !isMainTerminal(runtime.ctx) ||
      typeof request.sessionId !== "string" ||
      request.sessionId.length === 0 ||
      request.sessionId !== runtime.ctx.sessionManager.getSessionId()
    ) {
      return
    }

    runtime.exitRequestedSessionId = request.sessionId
    runtime.nativeUpdates?.close()
  })

  function hasMatchingExitRequest(state, ctx) {
    return (
      typeof state.exitRequestedSessionId === "string" &&
      state.exitRequestedSessionId === ctx.sessionManager.getSessionId()
    )
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
      const safeMessage = error.message.replace(
        /[\u0000-\u001f\u007f-\u009f]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
      ctx.ui.notify(`Recovery checkpoint unavailable: ${safeMessage}`, "error")
    }
  }

  async function refresh(ctx) {
    if (!runtime || runtime.closing || !isMainTerminal(ctx)) return
    runtime.ctx = ctx
    const state = runtime
    const pendingWrite = state.recordWrite ?? Promise.resolve()
    state.recordWrite = pendingWrite
      .catch(() => {})
      .then(async () => {
        try {
          await state.transport.writeRecord(record(ctx))
        } finally {
          await writeRestoreSnapshot(state, ctx)
        }
      })
    await state.recordWrite
    await requestRestartWhenPersisted(state)
  }

  async function requestRestartWhenPersisted(state) {
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

    const ctx = state.ctx
    const file = ctx.sessionManager.getSessionFile()
    if ((await sessionPersistence(ctx)) !== "persisted") return

    if (
      runtime !== state ||
      state.closing ||
      state.ctx !== ctx ||
      ctx.sessionManager.getSessionFile() !== file ||
      state.shutdownRequested ||
      hasMatchingExitRequest(state, ctx)
    ) {
      return
    }

    state.shutdownRequested = true
    ctx.shutdown()
  }

  async function handleRequest(request) {
    if (runtime.closing)
      throw new ProtocolError("INSTANCE_CLOSING", "This instance is shutting down.")
    const state = runtime
    const ctx = state.ctx
    if (request.action === "status") {
      const currentRecord = record(ctx)
      const [sendContext, canRestart] = await Promise.all([
        readSendContextMetadata(currentRecord),
        !hasMatchingExitRequest(state, ctx) &&
          !runtime.launch.restartError &&
          (await sessionPersistence(ctx)) === "persisted",
      ])
      return {
        data: {
          ...currentRecord,
          canRestart,
          sendContext,
          native: state.nativeUpdates?.getStatus() ?? null,
        },
      }
    }
    if (request.action === "restart-wrapper" && runtime.launch.canRestartWrapper !== true) {
      throw new ProtocolError(
        "WRAPPER_RESTART_UNAVAILABLE",
        "This launcher does not support wrapper restart; start a fresh OMP session from an updated ompi launcher."
      )
    }
    if (process.ppid !== runtime.launch.pid) {
      throw new ProtocolError("LAUNCHER_GONE", "The owning launcher is no longer attached.")
    }
    if (runtime.launch.restartError) {
      throw new ProtocolError("RESTART_ARGUMENTS_UNAVAILABLE", runtime.launch.restartError)
    }
    const persistence = await sessionPersistence(ctx)
    if (persistence === "unavailable") {
      throw new ProtocolError(
        "SESSION_UNAVAILABLE",
        "Restart requires a persistent transcript path to a regular file; ephemeral sessions cannot be resumed."
      )
    }
    rejectRestartAfterExitRequest(state, ctx)

    if (runtime.pending && runtime.pendingAction !== request.action) {
      throw new ProtocolError(
        "RESTART_ALREADY_PENDING",
        "A different restart operation is already pending for this instance."
      )
    }
    const firstRequest = !runtime.pending
    if (firstRequest) {
      runtime.restartAcknowledged = false
      runtime.pending = request.requestId
      runtime.pendingAction = request.action
      runtime.nativeTarget = request.nativeTarget ?? null
      runtime.admission = refresh(ctx)
    }
    if (request.nativeTarget) {
      runtime.nativeTarget = request.nativeTarget
    }
    const admission = runtime.admission
    try {
      await admission
    } catch (error) {
      if (runtime.admission === admission) {
        runtime.pending = null
        runtime.pendingAction = null
        runtime.nativeTarget = null
        runtime.admission = undefined
      }
      throw error
    }
    if (hasMatchingExitRequest(state, ctx)) {
      if (firstRequest && state.admission === admission && state.pending === request.requestId) {
        state.pending = null
        state.pendingAction = null
        state.nativeTarget = null
        state.admission = undefined
      }
      rejectRestartAfterExitRequest(state, ctx)
    }
    return {
      data: {
        state: "accepted",
        operationId: runtime.pending,
        message: "Restart requested; OMP will shut down at its settled boundary.",
      },
      afterReply: async () => {
        state.restartAcknowledged = true
        await requestRestartWhenPersisted(state)
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
      // OMP 18.8.7's public getFlag() is extension-local. This read-only private
      // boundary must fail closed until OMP exposes parsed flag metadata.
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
      const transport = await createTransport(scope)
      runtime = {
        launch: { ...launch, scope },
        transport,
        ctx,
        instanceId: randomBytes(16).toString("hex"),
        pending: null,
        pendingAction: null,
      }
      // Persist ownership before binding the socket or publishing the public record.
      await recordLaunchRegistration(launch, scope, runtime.instanceId)
      runtime.server = await transport.serve(runtime.instanceId, handleRequest, (error) => {
        ctx.ui.notify(`Instance control: ${error.message}`, "error")
      })
      await refresh(ctx)
      await refreshCompletions(ctx)
      ctx.ui.setStatus("instance-control", `instance ${runtime.instanceId.slice(0, 8)}`)
      const state = runtime
      if (state.launch.native && state.launch.canRestartWrapper === true) {
        state.nativeUpdates = watchNativeUpdates(state.launch.native, async (candidate) => {
          if (runtime !== state || state.closing || hasMatchingExitRequest(state, state.ctx)) {
            throw new ProtocolError("INSTANCE_CLOSING", "This instance is exiting.")
          }

          await requestWrapperRestart(state, {
            device: candidate.device,
            inode: candidate.inode,
            size: candidate.size,
            modifiedNs: candidate.modifiedNs,
          })
          state.ctx.ui.notify(
            `Installed native ompi ${candidate.installedVersion} detected; update accepted. OMP owns settlement before relaunch.`,
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
    if (ctx.agent.kind !== "main") {
      return
    }
    try {
      if (runtime && isMainTerminal(ctx)) {
        const state = runtime
        state.closing = true
        state.nativeUpdates?.close()
        try {
          if (runtime.pending && !hasMatchingExitRequest(runtime, ctx)) {
            writeRestartHandoff(runtime.launch, runtime.pending, runtime.instanceId, ctx, {
              restartWrapper: runtime.pendingAction === "restart-wrapper",
              nativeTarget: runtime.nativeTarget,
            })
          }
        } finally {
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
      }
    } finally {
      releaseClaim()
      releaseExitRequestListener()
    }
  })
}
