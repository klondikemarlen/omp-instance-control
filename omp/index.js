import { randomBytes } from "node:crypto"
import { realpath } from "node:fs/promises"
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
import {
  appendPersistedCooperativeEntry,
  COOPERATIVE_CHECKPOINT_TOOL_NAME,
  closeRestartTimer,
  createContinuationPrompt,
  createPreparationPrompt,
  describePendingAsyncWork,
  errorMessage,
  createToolTextResult,
  getCooperativeEntries,
  isOriginContext,
  MINIMUM_COOPERATIVE_HOST_VERSION,
  registerCooperativeCheckpointTool,
  sessionPersistence,
  supportsNonInterruptingAside,
  updateCooperativeStatus,
} from "./cooperative-restart.js"
import { requestWrapperRestart } from "./restart.js"

const ENTRY_CLAIM_EVENT = "omp-instance-control:entry-claim"
const EXIT_REQUESTED_EVENT = "omp-exit-command:exit-requested"

function isMainTerminal(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui"
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

  let cooperativeError
  if (launch) {
    if (!supportsNonInterruptingAside(pi)) {
      const hostVersion = pi.pi?.VERSION ?? "unknown"
      cooperativeError = `Cooperative restart requires OMP ${MINIMUM_COOPERATIVE_HOST_VERSION} or newer with public non-interrupting aside delivery; this host reports ${hostVersion}.`
    } else {
      try {
        registerCooperativeCheckpointTool(pi, executeRestartCheckpoint)
      } catch (error) {
        cooperativeError = `Cooperative restart is unavailable: ${errorMessage(error)}`
      }
    }
  }

  let runtime
  const refreshCompletions = registerOmpiCommand(pi, { getRuntime: () => runtime })
  const releaseExitRequestListener = pi.events.on(EXIT_REQUESTED_EVENT, (request) => {
    if (
      !runtime ||
      !isMainTerminal(runtime.ctx) ||
      typeof request.sessionId !== "string" ||
      request.sessionId.length === 0
    ) {
      return
    }

    const activeSessionId = runtime.ctx.sessionManager.getSessionId()
    if (request.sessionId !== activeSessionId && request.sessionId !== runtime.origin?.sessionId) {
      return
    }

    runtime.exitRequestedSessionId = request.sessionId
    runtime.nativeUpdates?.close()
    if (runtime.pending) {
      closeRestartTimer(runtime)
      runtime.checkpointReady = false
      updateCooperativeStatus(
        runtime,
        "blocked",
        "An explicit exit was requested; this restart and its automatic continuation are suppressed."
      )
      void refresh(runtime.ctx).catch((error) => {
        runtime.ctx.ui.notify(
          `Instance control status update failed: ${errorMessage(error)}`,
          "error"
        )
      })
    }
  })

  function hasMatchingExitRequest(state, ctx) {
    return (
      typeof state.exitRequestedSessionId === "string" &&
      (state.exitRequestedSessionId === ctx.sessionManager.getSessionId() ||
        state.exitRequestedSessionId === state.origin?.sessionId)
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
      ...(runtime.cooperative ? { cooperative: runtime.cooperative } : {}),
      ...(cooperativeError ? { cooperativeError } : {}),
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
    const state = runtime
    if (state.pending && !isOriginContext(state, ctx) && !hasMatchingExitRequest(state, ctx)) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The active session, transcript, or working directory changed; this restart cannot checkpoint or hand off the new context."
      )
    }
    state.ctx = ctx
    const pendingWrite = state.recordWrite ?? Promise.resolve()
    state.recordWrite = pendingWrite
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
    await requestRestartWhenPersisted(state)
  }

  async function publishCooperativeStatus(state) {
    const pendingWrite = state.recordWrite ?? Promise.resolve()
    state.recordWrite = pendingWrite
      .catch(() => {})
      .then(() => state.transport.writeRecord(record(state.ctx)))
    await state.recordWrite
  }

  async function requestRestartWhenPersisted(state) {
    if (
      runtime !== state ||
      state.closing ||
      !state.pending ||
      !state.restartAcknowledged ||
      !state.checkpointReady ||
      state.cooperative?.phase !== "restarting" ||
      state.shutdownRequested ||
      hasMatchingExitRequest(state, state.ctx)
    ) {
      return
    }

    const ctx = state.ctx
    if (!isOriginContext(state, ctx)) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The active session, transcript, or working directory changed before shutdown; the saved checkpoint was not handed off."
      )
      await publishCooperativeStatus(state)
      return
    }

    let checkpointStillActive
    try {
      checkpointStillActive = hasReadyCheckpoint(state, ctx)
    } catch (error) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        `OMP could not verify the active checkpoint branch; shutdown was not requested: ${errorMessage(error)}`
      )
      await publishCooperativeStatus(state)
      return
    }
    if (!checkpointStillActive) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The ready checkpoint is no longer on the active transcript branch; shutdown was not requested."
      )
      await publishCooperativeStatus(state)
      return
    }

    const file = ctx.sessionManager.getSessionFile()
    let persistence
    try {
      persistence = await sessionPersistence(ctx)
    } catch (error) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        `OMP could not verify transcript persistence; shutdown was not requested: ${errorMessage(error)}`
      )
      await publishCooperativeStatus(state)
      return
    }
    if (persistence !== "persisted") {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The checkpoint transcript is no longer persisted; shutdown was not requested."
      )
      await publishCooperativeStatus(state)
      return
    }
    if (
      runtime !== state ||
      state.closing ||
      state.shutdownRequested ||
      hasMatchingExitRequest(state, state.ctx)
    ) {
      return
    }

    const activeContext = state.ctx
    if (
      !isOriginContext(state, activeContext) ||
      activeContext.sessionManager.getSessionFile() !== file
    ) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The active session, transcript, or working directory changed before shutdown; no handoff was requested."
      )
      await publishCooperativeStatus(state)
      return
    }
    const checkpointStillActiveOnCurrentBranch = hasReadyCheckpoint(state, activeContext)
    if (!checkpointStillActiveOnCurrentBranch) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The ready checkpoint is no longer on the active transcript branch; shutdown was not requested."
      )
      await publishCooperativeStatus(state)
      return
    }

    state.shutdownRequested = true
    closeRestartTimer(state)
    try {
      activeContext.shutdown()
      state.restartTimer = setTimeout(
        () => {
          if (runtime !== state || state.closing || hasMatchingExitRequest(state, state.ctx)) return
          updateCooperativeStatus(
            state,
            "restarting",
            `The ready checkpoint is saved, but OMP still owns pending settlement. ${describePendingAsyncWork(state.ctx)} No shutdown was forced.`
          )
          void publishCooperativeStatus(state).catch((error) => {
            state.ctx.ui.notify(`Restart settlement status failed: ${errorMessage(error)}`, "error")
          })
        },
        Math.max(0, state.cooperative.requestedAt + 60_000 - Date.now())
      )
      state.restartTimer.unref?.()
    } catch (error) {
      state.shutdownRequested = false
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        `OMP could not accept graceful shutdown: ${errorMessage(error)}`
      )
      await publishCooperativeStatus(state)
    }
  }

  function hasReadyCheckpoint(state, ctx) {
    return getCooperativeEntries(ctx).some(
      (entry) =>
        entry?.entryId === state.checkpointEntryId &&
        entry.operationId === state.pending &&
        entry.ready === true
    )
  }

  function cooperativeApiError(ctx) {
    if (cooperativeError) return cooperativeError
    if (
      typeof pi.sendUserMessage !== "function" ||
      typeof pi.appendEntry !== "function" ||
      typeof ctx.sessionManager.getBranch !== "function" ||
      typeof ctx.shutdown !== "function"
    ) {
      return "OMP is missing a public API required for cooperative restart."
    }

    return null
  }

  function markPreparationBlocked(state, message) {
    if (
      runtime !== state ||
      state.closing ||
      state.checkpointReady ||
      hasMatchingExitRequest(state, state.ctx)
    ) {
      return
    }

    closeRestartTimer(state)
    updateCooperativeStatus(state, "blocked", message)
    void publishCooperativeStatus(state).catch((error) => {
      state.ctx.ui.notify(`Instance control status update failed: ${errorMessage(error)}`, "error")
    })
  }

  async function executeRestartCheckpoint(_toolCallId, params, _signal, _onUpdate, ctx) {
    const state = runtime
    if (!state?.pending || !state.restartAcknowledged || !isMainTerminal(ctx)) {
      return createToolTextResult(
        "There is no acknowledged main-session restart waiting for a checkpoint.",
        true
      )
    }
    if (params?.operationId !== state.pending) {
      return createToolTextResult(
        "The checkpoint operation ID does not match the accepted restart.",
        true
      )
    }
    if (!isOriginContext(state, ctx)) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The active session, transcript, or working directory changed; no checkpoint was written."
      )
      await publishCooperativeStatus(state)
      return createToolTextResult("The active context changed. No checkpoint was written.", true)
    }
    if (hasMatchingExitRequest(state, ctx)) {
      return createToolTextResult(
        "An explicit exit was requested; no restart checkpoint will be handed off.",
        true
      )
    }
    if (state.shutdownRequested) {
      return createToolTextResult(
        "This restart already has a saved checkpoint and graceful shutdown request."
      )
    }

    const apiError = cooperativeApiError(ctx)
    if (apiError) {
      markPreparationBlocked(state, apiError)
      return createToolTextResult(apiError, true)
    }
    if (typeof params?.checkpoint !== "string" || params.checkpoint.trim().length === 0) {
      return createToolTextResult(
        "Provide a useful non-empty checkpoint before reporting readiness.",
        true
      )
    }
    if (typeof params.ready !== "boolean") {
      return createToolTextResult("Set ready explicitly to true or false.", true)
    }

    const blocker = typeof params.blocker === "string" ? params.blocker.trim() : ""
    if (params.ready && blocker.length > 0) {
      return createToolTextResult(
        "Resolve or report blockers with ready: false before requesting shutdown.",
        true
      )
    }
    if (!params.ready && blocker.length === 0) {
      return createToolTextResult("A blocked checkpoint requires a concrete blocker.", true)
    }
    if (state.checkpointReady && state.cooperative?.phase === "restarting") {
      return createToolTextResult("A ready checkpoint is already saved for this restart.")
    }

    const checkpointAt = Date.now()
    const checkpoint = {
      entryId: randomBytes(16).toString("hex"),
      kind: "checkpoint",
      operationId: state.pending,
      previousInstanceId: state.instanceId,
      instanceId: state.instanceId,
      sessionId: state.origin.sessionId,
      sessionFile: state.origin.sessionFile,
      cwd: state.origin.cwd,
      scopeId: state.origin.scopeId,
      requestedAt: state.cooperative.requestedAt,
      checkpointAt,
      ready: params.ready,
      checkpoint: params.checkpoint,
      ...(blocker ? { blocker } : {}),
    }

    try {
      await appendPersistedCooperativeEntry(pi, ctx, checkpoint)
    } catch (error) {
      state.checkpointReady = false
      closeRestartTimer(state)
      updateCooperativeStatus(
        state,
        "blocked",
        `The checkpoint could not be persisted; shutdown was not requested: ${errorMessage(error)}`
      )
      await publishCooperativeStatus(state).catch(() => {})
      return createToolTextResult(state.cooperative.message, true)
    }
    if (runtime !== state || state.closing) {
      return createToolTextResult(
        "The restart instance is no longer active; the saved checkpoint will not trigger shutdown.",
        true
      )
    }
    if (
      !isOriginContext(state, ctx) ||
      !isOriginContext(state, state.ctx) ||
      hasMatchingExitRequest(state, ctx)
    ) {
      closeRestartTimer(state)
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        "The session changed or an explicit exit was requested while saving the checkpoint; no shutdown was requested."
      )
      await publishCooperativeStatus(state)
      return createToolTextResult(state.cooperative.message, true)
    }

    state.checkpointEntryId = checkpoint.entryId
    state.checkpointReady = params.ready
    closeRestartTimer(state)
    if (!params.ready) {
      updateCooperativeStatus(
        state,
        "blocked",
        `The agent reported a restart blocker: ${blocker}`,
        { checkpointAt }
      )
      try {
        await refresh(ctx)
      } catch (error) {
        updateCooperativeStatus(
          state,
          "blocked",
          `The saved blocker could not be published: ${errorMessage(error)}`,
          { checkpointAt }
        )
        await publishCooperativeStatus(state).catch(() => {})
        return createToolTextResult(state.cooperative.message, true)
      }
      return createToolTextResult(
        "The checkpoint and blocker were saved. Restart remains pending; no shutdown was requested."
      )
    }

    updateCooperativeStatus(
      state,
      "restarting",
      "The ready checkpoint is persisted. Requesting OMP-owned graceful shutdown; settlement is still pending.",
      { checkpointAt }
    )
    try {
      await refresh(ctx)
    } catch (error) {
      state.checkpointReady = false
      updateCooperativeStatus(
        state,
        "blocked",
        `The restart status could not be published; shutdown was not requested: ${errorMessage(error)}`
      )
      await publishCooperativeStatus(state).catch(() => {})
      return createToolTextResult(state.cooperative.message, true)
    }

    return createToolTextResult(
      "The ready checkpoint is persisted. OMP has been asked to shut down at its settled boundary; this does not confirm that settlement or replacement is complete."
    )
  }

  async function startCooperativePreparation(state) {
    if (
      runtime !== state ||
      state.closing ||
      !state.pending ||
      state.preparationSent ||
      hasMatchingExitRequest(state, state.ctx)
    ) {
      return
    }
    if (!isOriginContext(state, state.ctx)) {
      markPreparationBlocked(
        state,
        "The active session, transcript, or working directory changed before preparation; no message was sent."
      )
      return
    }

    state.preparationSent = true
    state.restartTimer = setTimeout(() => {
      if (
        runtime !== state ||
        state.closing ||
        state.checkpointReady ||
        state.cooperative?.phase !== "preparing"
      ) {
        return
      }
      const blocker = describePendingAsyncWork(state.ctx)
      markPreparationBlocked(
        state,
        `No ${COOPERATIVE_CHECKPOINT_TOOL_NAME} checkpoint report arrived within about 60 seconds. The accepted restart remains pending at the checkpoint phase. ${blocker}`
      )
    }, 60_000)
    state.restartTimer.unref?.()

    try {
      const delivery = pi.sendUserMessage(createPreparationPrompt(state.pending), {
        deliverAs: "aside",
      })
      if (delivery && typeof delivery.then === "function") {
        Promise.resolve(delivery).catch((error) => {
          markPreparationBlocked(
            state,
            `OMP reported a preparation-message delivery failure: ${errorMessage(error)}`
          )
        })
      }
    } catch (error) {
      markPreparationBlocked(
        state,
        `OMP could not deliver the preparation message: ${errorMessage(error)}`
      )
    }
  }

  async function blockReplacement(state, checkpoint, message) {
    const status = {
      operationId: checkpoint.operationId,
      phase: "blocked",
      message,
      requestedAt: Number.isSafeInteger(checkpoint.requestedAt)
        ? checkpoint.requestedAt
        : Date.now(),
    }
    if (Number.isSafeInteger(checkpoint.checkpointAt)) {
      status.checkpointAt = checkpoint.checkpointAt
    }
    state.cooperative = status
    await publishCooperativeStatus(state)
  }

  async function recordContinuationFailure(state, checkpoint, attempt, error) {
    if (runtime !== state || state.closing) return
    const message = `Continuation delivery reported an error after its attempt was recorded; no automatic retry was made because admission may be ambiguous: ${errorMessage(error)}`
    if (!isOriginContext(state, state.ctx)) {
      await blockReplacement(
        state,
        checkpoint,
        `${message} The session changed before failure state could be persisted; no other transcript was modified.`
      )
      return
    }
    try {
      await appendPersistedCooperativeEntry(pi, state.ctx, {
        entryId: randomBytes(16).toString("hex"),
        kind: "continuation",
        stage: "failed",
        operationId: checkpoint.operationId,
        previousInstanceId: checkpoint.previousInstanceId,
        replacementInstanceId: state.instanceId,
        sessionId: state.origin.sessionId,
        sessionFile: state.origin.sessionFile,
        cwd: state.origin.cwd,
        scopeId: state.origin.scopeId,
        attemptId: attempt.entryId,
        failedAt: Date.now(),
        message,
      })
    } catch {
      // The durable attempt marker still prevents an automatic duplicate send.
    }
    try {
      await blockReplacement(state, checkpoint, message)
    } catch (publishError) {
      state.ctx.ui.notify(
        `Cooperative continuation failure status could not be published: ${errorMessage(publishError)}`,
        "error"
      )
    }
  }

  async function resumeCooperativeRestart(state, ctx) {
    const correlation = state.launch.lastRestart
    if (
      !correlation ||
      typeof correlation.operationId !== "string" ||
      typeof correlation.previousInstanceId !== "string"
    ) {
      return
    }

    const entries = getCooperativeEntries(ctx)
    const correlatedCheckpoints = entries.filter(
      (entry) =>
        entry?.kind === "checkpoint" &&
        entry.operationId === correlation.operationId &&
        entry.previousInstanceId === correlation.previousInstanceId &&
        entry.instanceId === correlation.previousInstanceId
    )
    if (correlatedCheckpoints.length === 0) return

    const checkpoint = correlatedCheckpoints[correlatedCheckpoints.length - 1]
    const checkpointContextMatches =
      checkpoint.sessionId === state.origin.sessionId &&
      checkpoint.sessionFile === state.origin.sessionFile &&
      checkpoint.cwd === state.origin.cwd &&
      checkpoint.scopeId === state.origin.scopeId &&
      typeof checkpoint.checkpoint === "string" &&
      checkpoint.checkpoint.trim().length > 0 &&
      Number.isSafeInteger(checkpoint.requestedAt) &&
      Number.isSafeInteger(checkpoint.checkpointAt)

    if (!checkpointContextMatches) {
      await blockReplacement(
        state,
        checkpoint,
        "The saved checkpoint does not match this transcript, session, working directory, or launch scope; continuation was not sent."
      )
      return
    }
    if (!checkpoint.ready) {
      await blockReplacement(
        state,
        checkpoint,
        `The previous agent reported a blocker: ${checkpoint.blocker ?? "no safe boundary"}. No continuation was sent.`
      )
      return
    }

    const priorDelivery = entries.findLast(
      (entry) =>
        entry?.kind === "continuation" &&
        entry.operationId === correlation.operationId &&
        entry.previousInstanceId === correlation.previousInstanceId
    )
    if (priorDelivery?.stage === "submitted") {
      state.cooperative = {
        operationId: checkpoint.operationId,
        phase: "resumed",
        message: "The correlated continuation was already submitted to this session.",
        requestedAt: checkpoint.requestedAt,
        checkpointAt: checkpoint.checkpointAt,
        resumedAt: priorDelivery.submittedAt,
      }
      await publishCooperativeStatus(state)
      return
    }
    if (priorDelivery) {
      await blockReplacement(
        state,
        checkpoint,
        priorDelivery.message ??
          "A continuation attempt was recorded before this startup, but its admission is ambiguous; it was not sent again."
      )
      return
    }

    const apiError = cooperativeApiError(ctx)
    if (apiError) {
      await blockReplacement(state, checkpoint, apiError)
      return
    }
    if (hasMatchingExitRequest(state, ctx)) {
      await blockReplacement(
        state,
        checkpoint,
        "An explicit exit was requested; automatic continuation was suppressed."
      )
      return
    }

    state.cooperative = {
      operationId: checkpoint.operationId,
      phase: "resuming",
      message:
        "The correlated checkpoint is verified; submitting one continuation to this session.",
      requestedAt: checkpoint.requestedAt,
      checkpointAt: checkpoint.checkpointAt,
    }
    await refresh(ctx)
    if (
      runtime !== state ||
      state.closing ||
      !isOriginContext(state, ctx) ||
      !isOriginContext(state, state.ctx) ||
      hasMatchingExitRequest(state, state.ctx)
    ) {
      await blockReplacement(
        state,
        checkpoint,
        "The session changed or an explicit exit was requested before the continuation attempt; no message was sent."
      )
      return
    }

    const attempt = {
      entryId: randomBytes(16).toString("hex"),
      kind: "continuation",
      stage: "attempted",
      operationId: checkpoint.operationId,
      previousInstanceId: checkpoint.previousInstanceId,
      replacementInstanceId: state.instanceId,
      sessionId: state.origin.sessionId,
      sessionFile: state.origin.sessionFile,
      cwd: state.origin.cwd,
      scopeId: state.origin.scopeId,
      checkpointEntryId: checkpoint.entryId,
      attemptedAt: Date.now(),
    }
    try {
      await appendPersistedCooperativeEntry(pi, ctx, attempt)
    } catch (error) {
      await blockReplacement(
        state,
        checkpoint,
        `The continuation attempt marker could not be persisted; no message was sent: ${errorMessage(error)}`
      )
      return
    }
    if (
      runtime !== state ||
      state.closing ||
      !isOriginContext(state, ctx) ||
      !isOriginContext(state, state.ctx) ||
      hasMatchingExitRequest(state, state.ctx)
    ) {
      await blockReplacement(
        state,
        checkpoint,
        "The session changed or an explicit exit was requested while saving the continuation attempt; no message was sent."
      )
      return
    }

    let delivery
    try {
      delivery = pi.sendUserMessage(createContinuationPrompt(checkpoint), {
        deliverAs: "aside",
      })
    } catch (error) {
      await recordContinuationFailure(state, checkpoint, attempt, error)
      return
    }
    const deliveryOutcome =
      delivery && typeof delivery.then === "function"
        ? Promise.resolve(delivery).then(
            () => null,
            (error) => error
          )
        : null
    const submittedAt = Date.now()
    try {
      await appendPersistedCooperativeEntry(pi, ctx, {
        entryId: randomBytes(16).toString("hex"),
        kind: "continuation",
        stage: "submitted",
        operationId: checkpoint.operationId,
        previousInstanceId: checkpoint.previousInstanceId,
        replacementInstanceId: state.instanceId,
        sessionId: state.origin.sessionId,
        sessionFile: state.origin.sessionFile,
        cwd: state.origin.cwd,
        scopeId: state.origin.scopeId,
        attemptId: attempt.entryId,
        submittedAt,
      })
    } catch (error) {
      await blockReplacement(
        state,
        checkpoint,
        `Continuation was invoked, but its submission marker could not be persisted; no retry was made: ${errorMessage(error)}`
      )
      return
    }

    state.cooperative = {
      operationId: checkpoint.operationId,
      phase: "resumed",
      message:
        "The correlated continuation was submitted to this session; agent work may still be in progress.",
      requestedAt: checkpoint.requestedAt,
      checkpointAt: checkpoint.checkpointAt,
      resumedAt: submittedAt,
    }
    await publishCooperativeStatus(state)
    if (deliveryOutcome) {
      void deliveryOutcome.then((error) => {
        if (error) {
          void recordContinuationFailure(state, checkpoint, attempt, error).catch((failure) => {
            state.ctx.ui.notify(
              `Cooperative continuation failure handling failed: ${errorMessage(failure)}`,
              "error"
            )
          })
        }
      })
    }
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
          !cooperativeApiError(ctx) &&
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
    const apiError = cooperativeApiError(ctx)
    if (apiError) {
      throw new ProtocolError("COOPERATIVE_RESTART_UNAVAILABLE", apiError)
    }
    const persistence = await sessionPersistence(ctx)
    if (persistence === "unavailable") {
      throw new ProtocolError(
        "SESSION_UNAVAILABLE",
        "Restart requires a persistent transcript path to a regular file; ephemeral sessions cannot be resumed."
      )
    }
    rejectRestartAfterExitRequest(state, ctx)
    if (runtime.pending && !isOriginContext(state, ctx)) {
      throw new ProtocolError(
        "RESTART_CONTEXT_CHANGED",
        "A restart is already pending for a different session, transcript, working directory, or launch scope."
      )
    }

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
      runtime.origin = {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        scopeId: runtime.launch.scope.id,
      }
      runtime.cooperative = {
        operationId: request.requestId,
        phase: "preparing",
        message: "Restart accepted; waiting for a cooperative safe-boundary checkpoint.",
        requestedAt: Date.now(),
      }
      runtime.checkpointReady = false
      runtime.preparationSent = false
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
        closeRestartTimer(state)
        state.pending = null
        state.pendingAction = null
        state.nativeTarget = null
        state.origin = undefined
        state.cooperative = undefined
        state.checkpointReady = false
        state.preparationSent = false
        state.admission = undefined
      }
      throw error
    }
    if (hasMatchingExitRequest(state, ctx)) {
      if (firstRequest && state.admission === admission && state.pending === request.requestId) {
        state.pending = null
        state.pendingAction = null
        state.nativeTarget = null
        state.origin = undefined
        state.cooperative = undefined
        state.checkpointReady = false
        state.preparationSent = false
        state.admission = undefined
      }
      rejectRestartAfterExitRequest(state, ctx)
    }
    return {
      data: {
        state: "accepted",
        operationId: runtime.pending,
        message: "Restart accepted; preparation is sent through OMP's non-interrupting aside path.",
        cooperative: runtime.cooperative,
      },
      afterReply: async () => {
        state.restartAcknowledged = true
        if (hasMatchingExitRequest(state, state.ctx)) {
          closeRestartTimer(state)
          state.checkpointReady = false
          updateCooperativeStatus(
            state,
            "blocked",
            "An explicit exit was requested; preparation and automatic continuation are suppressed."
          )
          await publishCooperativeStatus(state)
          return
        }
        await startCooperativePreparation(state)
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
      // Persist ownership before binding the socket or publishing the public record.
      await recordLaunchRegistration(launch, scope, runtime.instanceId)
      runtime.server = await runtime.transport.serve(runtime.instanceId, handleRequest, (error) => {
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
      try {
        await resumeCooperativeRestart(state, ctx)
      } catch (error) {
        const correlation = state.launch.lastRestart
        if (
          correlation &&
          typeof correlation.operationId === "string" &&
          typeof correlation.previousInstanceId === "string"
        ) {
          const message = `The correlated cooperative continuation could not be prepared: ${errorMessage(error)}`
          if (state.cooperative) {
            updateCooperativeStatus(state, "blocked", message)
          } else {
            state.cooperative = {
              operationId: correlation.operationId,
              phase: "blocked",
              message,
              requestedAt: Date.now(),
            }
          }
          await publishCooperativeStatus(state).catch((publishError) => {
            ctx.ui.notify(
              `Instance control status update failed: ${errorMessage(publishError)}`,
              "error"
            )
          })
        } else {
          ctx.ui.notify(`Cooperative continuation unavailable: ${errorMessage(error)}`, "error")
        }
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
    if (runtime) closeRestartTimer(runtime)

    try {
      if (runtime && isMainTerminal(ctx)) {
        const state = runtime
        state.closing = true
        closeRestartTimer(state)
        state.nativeUpdates?.close()
        try {
          if (
            state.pending &&
            state.shutdownRequested &&
            state.checkpointReady &&
            state.cooperative?.phase === "restarting" &&
            isOriginContext(state, ctx) &&
            hasReadyCheckpoint(state, ctx) &&
            !hasMatchingExitRequest(state, ctx)
          ) {
            writeRestartHandoff(state.launch, state.pending, state.instanceId, ctx, {
              restartWrapper: state.pendingAction === "restart-wrapper",
              nativeTarget: state.nativeTarget,
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
