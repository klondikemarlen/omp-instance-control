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
