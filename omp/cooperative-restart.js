import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createInterface } from "node:readline"

export const MINIMUM_COOPERATIVE_HOST_VERSION = "18.13.2"

export function supportsNonInterruptingAside(pi) {
  const version = parseStableVersion(pi.pi?.VERSION)
  if (!version) return false

  const minimum = [18, 13, 2]
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index]
  }

  return true
}

function parseStableVersion(version) {
  if (typeof version !== "string") return null
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null

  const parts = match.slice(1).map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) return null

  return parts
}

export const COOPERATIVE_ENTRY_TYPE = "ompi-cooperative-restart"
export const COOPERATIVE_CHECKPOINT_TOOL_NAME = "ompi_restart_checkpoint"

export function registerCooperativeCheckpointTool(pi, execute) {
  const schema = pi.pi?.z
  if (
    typeof pi.registerTool !== "function" ||
    typeof schema?.object !== "function" ||
    typeof schema.string !== "function" ||
    typeof schema.boolean !== "function"
  ) {
    throw new Error("OMP's public tool registration and Zod APIs are unavailable.")
  }

  pi.registerTool({
    name: COOPERATIVE_CHECKPOINT_TOOL_NAME,
    label: "Restart checkpoint",
    description:
      "Save a checkpoint for the accepted ompi restart operation. Report ready only at a safe pause boundary; report a concrete blocker otherwise.",
    loadMode: "essential",
    parameters: schema.object({
      operationId: schema.string(),
      checkpoint: schema.string(),
      ready: schema.boolean(),
      blocker: schema.string().optional(),
    }),
    execute,
  })
}

export function getCooperativeEntries(ctx) {
  if (typeof ctx.sessionManager?.getBranch !== "function") {
    throw new Error("OMP's public read-only session branch API is unavailable.")
  }
  return ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === COOPERATIVE_ENTRY_TYPE)
    .map((entry) => entry.data)
}

export async function appendPersistedCooperativeEntry(pi, ctx, data) {
  if (typeof pi.appendEntry !== "function") {
    throw new Error("OMP's public appendEntry API is unavailable.")
  }

  const sessionFile = ctx.sessionManager.getSessionFile()
  if (typeof sessionFile !== "string" || sessionFile.length === 0) {
    throw new Error("The active transcript has no persistent session file.")
  }

  pi.appendEntry(COOPERATIVE_ENTRY_TYPE, data)

  const branchEntryExists = getCooperativeEntries(ctx).some(
    (entry) => entry?.entryId === data.entryId && entry.operationId === data.operationId
  )
  if (!branchEntryExists) {
    throw new Error(
      "OMP did not retain the cooperative checkpoint in the active transcript branch."
    )
  }

  const persisted = await sessionFileContainsEntry(sessionFile, data.entryId, data.operationId)
  if (!persisted) {
    throw new Error("OMP did not persist the cooperative checkpoint to the session transcript.")
  }
}

async function sessionFileContainsEntry(sessionFile, entryId, operationId) {
  const input = createReadStream(sessionFile, { encoding: "utf8" })
  const lines = createInterface({ input, crlfDelay: Infinity })

  try {
    for await (const line of lines) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      if (
        entry.type === "custom" &&
        entry.customType === COOPERATIVE_ENTRY_TYPE &&
        entry.data?.entryId === entryId &&
        entry.data.operationId === operationId
      ) {
        return true
      }
    }

    return false
  } finally {
    lines.close()
    input.destroy()
  }
}

export function createToolTextResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  }
}

export async function sessionPersistence(ctx) {
  const file = ctx.sessionManager.getSessionFile()
  if (!file) return "unavailable"

  try {
    return (await stat(file)).isFile() ? "persisted" : "unavailable"
  } catch (error) {
    if (error.code === "ENOENT") return "unmaterialized"

    throw error
  }
}

export function isOriginContext(state, ctx) {
  return (
    state.origin &&
    ctx.cwd === state.origin.cwd &&
    ctx.sessionManager.getSessionId() === state.origin.sessionId &&
    ctx.sessionManager.getSessionFile() === state.origin.sessionFile &&
    state.launch.scope.id === state.origin.scopeId
  )
}

export function updateCooperativeStatus(state, phase, message, { checkpointAt, resumedAt } = {}) {
  const current = state.cooperative
  const status = {
    operationId: state.pending ?? current?.operationId,
    phase,
    message,
    requestedAt: current?.requestedAt ?? Date.now(),
  }
  if (current?.mode !== undefined) status.mode = current.mode
  const savedCheckpointAt = checkpointAt ?? current?.checkpointAt
  const savedResumedAt = resumedAt ?? current?.resumedAt
  if (savedCheckpointAt !== undefined) status.checkpointAt = savedCheckpointAt
  if (savedResumedAt !== undefined) status.resumedAt = savedResumedAt
  state.cooperative = status
}

export function closeRestartTimer(state) {
  if (!state.restartTimer) return
  clearTimeout(state.restartTimer)
  state.restartTimer = undefined
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createPreparationPrompt(operationId) {
  return [
    `ompi accepted restart operation ${operationId}. Prepare to pause this session for restart.`,
    `Stop starting new work. Reach a genuinely safe boundary for work already in progress; do not stop or claim to preserve arbitrary subprocesses or background jobs.`,
    `Checkpoint completed work, remaining work, side effects already performed, and relevant job identities. State which jobs or side effects cannot safely survive shutdown, and report any concrete blocker honestly.`,
    `When ready, call ${COOPERATIVE_CHECKPOINT_TOOL_NAME} with operationId "${operationId}", a useful checkpoint, ready: true, and no blocker. If you cannot safely pause, call it with ready: false and a concrete blocker instead.`,
    `A checkpoint is not proof that OMP has settled. ompi will request only OMP's public graceful shutdown after a ready checkpoint is saved.`,
  ].join("\n\n")
}

export function createContinuationPrompt(checkpoint) {
  return [
    `Continue the original task after cooperative restart operation ${checkpoint.operationId}.`,
    `Review the conversation and checkpoint below. Do not repeat completed side effects; continue only the unfinished work and verify what is safe to verify.`,
    `The checkpoint describes agent work only. Do not assume any subprocess or background job survived; inspect or restart such work safely and report uncertainty.`,
    "Saved checkpoint:",
    checkpoint.checkpoint,
  ].join("\n\n")
}

export function describePendingAsyncWork(ctx) {
  if (typeof ctx.getAsyncJobSnapshot !== "function") {
    return "OMP's public async-job snapshot is unavailable."
  }

  let snapshot
  try {
    snapshot = ctx.getAsyncJobSnapshot()
  } catch (error) {
    return `OMP's async-job snapshot failed: ${errorMessage(error)}`
  }
  if (!snapshot) return "OMP provided no async-job snapshot."

  const details = []
  const runningJobs = Array.isArray(snapshot.running) ? snapshot.running : []
  if (runningJobs.length > 0) {
    const types = runningJobs
      .map((job) => job.type)
      .filter((type) => typeof type === "string" && type.length > 0)
    const summary = types.length > 0 ? ` (${types.slice(0, 3).join(", ")})` : ""
    details.push(`${runningJobs.length} running OMP async job(s)${summary}`)
  }

  const delivery = snapshot.delivery
  if (Number.isSafeInteger(delivery?.queued) && delivery.queued > 0) {
    details.push(`${delivery.queued} queued async job result delivery(s)`)
  }
  if (delivery?.delivering === true) {
    details.push("OMP is delivering an async job result")
  }
  const pendingJobIds = Array.isArray(delivery?.pendingJobIds) ? delivery.pendingJobIds : []
  if (
    pendingJobIds.length > 0 &&
    !(Number.isSafeInteger(delivery?.queued) && delivery.queued > 0)
  ) {
    details.push(`${pendingJobIds.length} async job result(s) remain pending delivery`)
  }

  return details.length > 0
    ? details.join("; ")
    : "OMP reports no running async jobs or queued job result deliveries."
}

export function isPubliclyIdle(ctx) {
  if (
    typeof ctx.isIdle !== "function" ||
    typeof ctx.hasPendingMessages !== "function" ||
    typeof ctx.getAsyncJobSnapshot !== "function"
  ) {
    return false
  }

  try {
    if (ctx.isIdle() !== true || ctx.hasPendingMessages() !== false) return false
    const snapshot = ctx.getAsyncJobSnapshot()
    return (
      snapshot !== null &&
      typeof snapshot === "object" &&
      Array.isArray(snapshot.running) &&
      snapshot.running.length === 0 &&
      Number.isSafeInteger(snapshot.delivery?.queued) &&
      snapshot.delivery.queued === 0 &&
      snapshot.delivery.delivering === false &&
      Array.isArray(snapshot.delivery.pendingJobIds) &&
      snapshot.delivery.pendingJobIds.length === 0
    )
  } catch {
    return false
  }
}

export async function appendPersistedIdleCheckpoint(pi, ctx, checkpoint, isCurrent) {
  if (!isPubliclyIdle(ctx) || !isCurrent()) return false
  await appendPersistedCooperativeEntry(pi, ctx, checkpoint)
  return isPubliclyIdle(ctx) && isCurrent()
}

export async function persistIdleCheckpoint(pi, state, isCurrent) {
  const checkpoint = {
    entryId: `${state.pending}:idle:${state.instanceId}`,
    kind: "checkpoint",
    mode: "idle",
    operationId: state.pending,
    previousInstanceId: state.instanceId,
    instanceId: state.instanceId,
    sessionId: state.origin.sessionId,
    sessionFile: state.origin.sessionFile,
    cwd: state.origin.cwd,
    scopeId: state.origin.scopeId,
    requestedAt: state.cooperative.requestedAt,
    checkpointAt: Date.now(),
    ready: true,
    checkpoint: "",
  }
  if (!(await appendPersistedIdleCheckpoint(pi, state.ctx, checkpoint, isCurrent))) return null
  return checkpoint
}

export function checkpointMatchesOrigin(checkpoint, origin) {
  const idle = checkpoint.mode === "idle"
  return (
    checkpoint.sessionId === origin.sessionId &&
    checkpoint.sessionFile === origin.sessionFile &&
    checkpoint.cwd === origin.cwd &&
    checkpoint.scopeId === origin.scopeId &&
    (idle
      ? checkpoint.entryId === `${checkpoint.operationId}:idle:${checkpoint.previousInstanceId}` &&
        checkpoint.checkpoint === "" &&
        checkpoint.ready === true
      : typeof checkpoint.checkpoint === "string" && checkpoint.checkpoint.trim().length > 0) &&
    Number.isSafeInteger(checkpoint.requestedAt) &&
    Number.isSafeInteger(checkpoint.checkpointAt)
  )
}

export function createIdleResumedStatus(checkpoint) {
  const resumedAt = Date.now()
  return {
    operationId: checkpoint.operationId,
    mode: "idle",
    phase: "resumed",
    message: "The correlated idle session was reopened; no model continuation was requested.",
    requestedAt: checkpoint.requestedAt,
    checkpointAt: checkpoint.checkpointAt,
    resumedAt,
  }
}

export function hasReadyCheckpoint(state, ctx) {
  return getCooperativeEntries(ctx).some(
    (entry) =>
      entry?.entryId === state.checkpointEntryId &&
      entry.operationId === state.pending &&
      entry.ready === true
  )
}

export function getCooperativeApiError(pi, ctx, cooperativeError) {
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

export function createBlockedCooperativeStatus(checkpoint, message) {
  return {
    operationId: checkpoint.operationId,
    ...(checkpoint.mode === "idle" ? { mode: "idle" } : {}),
    phase: "blocked",
    message,
    requestedAt: Number.isSafeInteger(checkpoint.requestedAt) ? checkpoint.requestedAt : Date.now(),
    ...(Number.isSafeInteger(checkpoint.checkpointAt)
      ? { checkpointAt: checkpoint.checkpointAt }
      : {}),
  }
}

export function resetIdleCheckpointForPreparation(state, message) {
  state.checkpointReady = false
  state.preparationSent = false
  state.checkpointEntryId = undefined
  state.cooperative = {
    operationId: state.pending,
    phase: "preparing",
    message,
    requestedAt: state.cooperative.requestedAt,
  }
}

export function markCooperativePreparationBlocked(state, message, canBlock, publish, notify) {
  if (!canBlock()) return
  closeRestartTimer(state)
  updateCooperativeStatus(state, "blocked", message)
  void publish().catch(notify)
}

export function sendCooperativePreparation(pi, state, isCurrent, markBlocked) {
  state.restartTimer = setTimeout(() => {
    if (
      !isCurrent() ||
      state.closing ||
      state.checkpointReady ||
      state.cooperative?.phase !== "preparing"
    ) {
      return
    }
    markBlocked(
      `No ${COOPERATIVE_CHECKPOINT_TOOL_NAME} checkpoint report arrived within about 60 seconds. The accepted restart remains pending at the checkpoint phase. ${describePendingAsyncWork(state.ctx)}`
    )
  }, 60_000)
  state.restartTimer.unref?.()

  try {
    const delivery = pi.sendUserMessage(createPreparationPrompt(state.pending), {
      deliverAs: "aside",
    })
    if (delivery && typeof delivery.then === "function") {
      Promise.resolve(delivery).catch((error) => {
        markBlocked(`OMP reported a preparation-message delivery failure: ${errorMessage(error)}`)
      })
    }
  } catch (error) {
    markBlocked(`OMP could not deliver the preparation message: ${errorMessage(error)}`)
  }
}
