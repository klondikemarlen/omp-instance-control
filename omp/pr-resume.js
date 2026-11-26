import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import { findResumeCandidates, revalidateResumeCandidate } from "../linux/pr-resume.js"
import { readPRResumeClaims } from "./work-command.js"

export const RESUME_HELP = [
  "Usage: /ompi resume https://github.com/OWNER/REPO/pull/N",
  "Choose and confirm the original saved conversation in this managed terminal's launch scope.",
  "Only conversations in this directory can be opened; active or uncertain ownership is refused.",
]

const CANCELLED = {
  status: "cancelled",
  message: "PR resume cancelled.",
}
const RESUME_ENTRY = "ompi-pr-resume"
const STARTUP_SELECTOR_ENTRIES = new Set([
  "model_change",
  "thinking_level_change",
  "service_tier_change",
  "mode_change",
  "credential_pin",
])
const TARGET_CHANGED =
  "The selected PR conversation changed or disappeared; run /ompi resume again."
const SOURCE_CHANGED =
  "The current conversation changed; run /ompi resume again in the intended terminal."
const OWNERSHIP_UNCONFIRMED =
  "OMP did not confirm durable ownership of the original PR conversation. Check which conversation is active before continuing."

export async function resumePullRequest(url, ctx, getRuntime, pi, { freshStart = false } = {}) {
  const runtime = getRuntime()
  const scope = runtime?.launch?.scope
  if (!scope || !runtime.transport) {
    throw new Error("/ompi resume requires a launcher-managed ompi terminal.")
  }

  // ExtensionAPI.pi is the host's public coding-agent SDK. Use its storage
  // implementation so lease reservations share the host's process-local state.
  const { FileSessionStorage, SessionManager, probeSessionLeases, readSessionHeaderId } =
    pi?.pi ?? {}
  const manager = ctx.sessionManager
  if (
    typeof FileSessionStorage !== "function" ||
    typeof FileSessionStorage.prototype.claimSession !== "function" ||
    typeof FileSessionStorage.prototype.isSessionOwnedElsewhere !== "function" ||
    typeof SessionManager !== "function" ||
    typeof probeSessionLeases !== "function" ||
    typeof readSessionHeaderId !== "function" ||
    typeof ctx.switchSession !== "function" ||
    typeof pi.appendEntry !== "function"
  ) {
    throw new Error(
      "This OMP host cannot safely resume an original session. Use OMP's /resume picker manually."
    )
  }
  if (!(manager instanceof SessionManager)) {
    throw new Error("PR resume requires a local OMP conversation, not a remote session.")
  }

  const source = sessionIdentity(ctx)
  const sourceLeaf = manager.getLeafId()
  if (
    !source.sessionId ||
    !source.sessionFile ||
    !path.isAbsolute(source.sessionFile) ||
    !path.isAbsolute(source.cwd ?? "") ||
    manager.getHeader().origin !== undefined
  ) {
    throw new Error("Save the current local OMP conversation before resuming PR work.")
  }

  const sourceStamp = await savedSessionStamp(source.sessionFile)
  if (freshStart && (sourceStamp !== undefined || !isFreshPRResumeSession(manager))) {
    throw new Error("Shell PR resume requires the fresh OMP conversation that opened here.")
  }
  if (
    !freshStart &&
    (!sourceStamp || (await readSessionHeaderId(source.sessionFile)) !== source.sessionId)
  ) {
    throw new Error("The current OMP transcript is unavailable; save it before resuming PR work.")
  }

  async function requireUnchangedSource({ switching = false } = {}) {
    const currentStamp = await savedSessionStamp(source.sessionFile)
    const sameSource = freshStart
      ? currentStamp === undefined && isFreshPRResumeSession(manager)
      : sameStamp(currentStamp, sourceStamp)
    if (
      getRuntime() !== runtime ||
      runtime.launch.scope !== scope ||
      runtime.launch.pid !== process.ppid ||
      runtime.ctx?.sessionManager !== manager ||
      runtime.ctx.cwd !== source.cwd ||
      ctx.cwd !== source.cwd ||
      source.cwd !== manager.getRecordedCwd() ||
      !isSameSession(sessionIdentity(ctx), source) ||
      manager.getLeafId() !== sourceLeaf ||
      !sameSource
    ) {
      throw new Error(SOURCE_CHANGED)
    }
    if (
      runtime.closing ||
      runtime.pending ||
      runtime.shutdownRequested ||
      runtime.exitRequestedSessionId ||
      (!switching && runtime.resumingPR) ||
      !isQuiescent(ctx)
    ) {
      throw new Error(
        "The current OMP conversation is busy or has pending work. Finish it before resuming PR work."
      )
    }
  }

  await requireUnchangedSource()
  const claims = await readPRResumeClaims(runtime, source.cwd, url)
  const candidates = await findResumeCandidates(scope, url, claims, source.cwd)
  await requireUnchangedSource()
  if (candidates.length === 0) {
    return {
      status: "not-found",
      message: "No saved PR conversation found in this directory or claimed in this ompi profile.",
    }
  }

  const labels = candidates.map((candidate, index) =>
    candidateLabel(candidate, index, claims, scope, url)
  )
  const choice = await ctx.ui.select("Choose a PR conversation to resume", labels)
  if (choice === undefined) {
    return CANCELLED
  }

  const selectedIndex = labels.indexOf(choice)
  const target = candidates[selectedIndex]
  if (!target) {
    throw new Error("OMP did not return a valid PR conversation selection.")
  }

  await requireUnchangedSource()
  if (isSameSession(source, target)) {
    return {
      status: "already-active",
      message: "This PR conversation is already active in this terminal.",
    }
  }
  if (target.sessionId === source.sessionId || target.sessionFile === source.sessionFile) {
    throw new Error(TARGET_CHANGED)
  }

  await requireNoManagedOwner(runtime, target)
  requireFreeLease(probeSessionLeases, target.sessionId)
  await requireUnchangedSource()

  // The 19.2.1 extension command supplies no onCwdChange callback. Its native
  // picker is a distinct path that can change projects with the user's input.
  if (target.cwd !== source.cwd) {
    throw new Error(
      "This PR conversation uses another directory. Use OMP's /resume picker manually; this terminal was not switched."
    )
  }

  const targetStamp = await savedSessionStamp(target.sessionFile)
  if (!targetStamp) {
    throw new Error(TARGET_CHANGED)
  }

  const sourceDescription = freshStart
    ? "This fresh conversation has no saved history to replace."
    : "Your current conversation will stay guarded and saved during the switch."
  const confirmed = await ctx.ui.confirm(
    "Resume the original PR conversation?",
    `Open ${choice} here and acquire its free OMP ownership lease. ${sourceDescription}`
  )
  if (confirmed !== true) {
    return CANCELLED
  }

  await requireUnchangedSource()
  const currentClaims = await readPRResumeClaims(runtime, source.cwd, url)
  await requireUnchangedSource()
  if (runtime.resumingPR) {
    throw new Error("A PR resume is already in progress in this terminal.")
  }

  runtime.resumingPR = true
  let releaseSource
  let releaseTarget
  try {
    const storage = new FileSessionStorage()
    requireFreeLease(probeSessionLeases, target.sessionId)
    // FileSessionStorage's claims share the host's process-local reference
    // count. Protect both journals across the host's async switch and rollback.
    if (!freshStart) {
      releaseSource = claimJournal(storage, probeSessionLeases, source)
    }
    releaseTarget = claimJournal(storage, probeSessionLeases, target)
    const latest = await revalidateResumeCandidate(scope, url, currentClaims, target)
    if (
      !latest ||
      !isSameSession(latest, target) ||
      latest.evidence !== target.evidence ||
      latest.updatedAt !== target.updatedAt ||
      candidateLabel(latest, selectedIndex, currentClaims, scope, url) !== choice
    ) {
      throw new Error(TARGET_CHANGED)
    }

    await requireNoManagedOwner(runtime, target)
    const latestStamp = await savedSessionStamp(target.sessionFile)
    await requireUnchangedSource({ switching: true })
    if (!sameStamp(latestStamp, targetStamp)) {
      throw new Error(TARGET_CHANGED)
    }

    let result
    try {
      result = await ctx.switchSession(target.sessionFile)
    } catch {
      throw new Error(
        "OMP could not resume the original PR conversation. Check which conversation is active before continuing."
      )
    }

    if (result?.cancelled === true && isSameSession(sessionIdentity(ctx), source)) {
      return {
        status: "cancelled",
        message: "OMP cancelled PR resume; the previous conversation is still active.",
      }
    }
    if (
      result?.cancelled !== false ||
      !isSameSession(sessionIdentity(ctx), target) ||
      manager.getRecordedCwd() !== target.cwd
    ) {
      throw new Error(
        "OMP did not confirm the selected original PR conversation. Check which conversation is active before continuing."
      )
    }

    // Opening alone does not make SessionManager a writer. This non-prompt
    // entry makes the host retain its own lease without starting a model turn.
    try {
      pi.appendEntry(RESUME_ENTRY)
    } catch {
      throw new Error(OWNERSHIP_UNCONFIRMED)
    }

    releaseTarget()
    releaseTarget = undefined
    if (
      !isSameSession(sessionIdentity(ctx), target) ||
      !hasLocalLease(storage, probeSessionLeases, target)
    ) {
      throw new Error(OWNERSHIP_UNCONFIRMED)
    }

    return {
      status: "resumed",
      message: "Resumed the original PR conversation in this terminal.",
    }
  } finally {
    releaseTarget?.()
    releaseSource?.()
    runtime.resumingPR = false
  }
}

export function isFreshPRResumeSession(manager) {
  if (manager?.isSessionOnDisk?.() !== false || manager.getHeader().origin !== undefined) {
    return false
  }

  // Only host startup selector metadata may exist before the first submission.
  const entries = manager.getEntries?.()
  return Array.isArray(entries) && entries.every(({ type }) => STARTUP_SELECTOR_ENTRIES.has(type))
}

function sessionIdentity(ctx) {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    cwd: ctx.sessionManager.getCwd(),
  }
}

function isSameSession(first, second) {
  return (
    first.sessionId === second.sessionId &&
    first.sessionFile === second.sessionFile &&
    first.cwd === second.cwd
  )
}

function isQuiescent(ctx) {
  if (
    typeof ctx.isIdle !== "function" ||
    typeof ctx.hasPendingMessages !== "function" ||
    typeof ctx.getAsyncJobSnapshot !== "function" ||
    ctx.isIdle() !== true ||
    ctx.hasPendingMessages() !== false ||
    ctx.getPendingPlanReview?.()
  ) {
    return false
  }

  const jobs = ctx.getAsyncJobSnapshot()
  return (
    jobs === null ||
    (jobs?.running?.length === 0 &&
      jobs.delivery?.queued === 0 &&
      jobs.delivery.delivering === false)
  )
}

function candidateLabel(
  { evidence, cwd, updatedAt, sessionId, sessionFile },
  index,
  claims,
  scope,
  url
) {
  const claim = claims.find(
    (row) =>
      row?.version === 1 &&
      row.scope === scope.id &&
      row.url === url &&
      row.sessionId === sessionId &&
      row.sessionFile === sessionFile
  )
  const safeBranch = safeLabelText(claim?.branch)
  const safeSummary = safeLabelText(claim?.summary)
  const detail = safeBranch || safeSummary || safeLabelText(path.basename(cwd))
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "?").slice(-8)
  return `${evidence} — ${detail} — ${updatedAt} — ${safeId} (${index + 1})`
}

function safeLabelText(text) {
  if (typeof text !== "string") {
    return ""
  }

  return text
    .replace(/[^\p{L}\p{N} ._/-]/gu, "?")
    .trim()
    .slice(0, 48)
}

async function savedSessionStamp(file) {
  try {
    const stamp = await lstat(file, {
      bigint: true,
    })
    if (stamp.isFile() && stamp.nlink === 1n && (await realpath(file)) === file) {
      return stamp
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined
    }
    throw error
  }

  return null
}

function sameStamp(first, second) {
  return (
    first != null &&
    second != null &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.ctimeNs === second.ctimeNs &&
    first.mtimeNs === second.mtimeNs
  )
}

function processMayBeAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

async function requireNoManagedOwner(runtime, target) {
  const records = await runtime.transport.readRecords()
  const owner = records.find(
    (record) =>
      record.instanceId !== runtime.instanceId &&
      (record.sessionId === target.sessionId || record.sessionFile === target.sessionFile) &&
      (record.state === "restart-requested" || processMayBeAlive(record.pid))
  )
  if (owner) {
    throw new Error(
      "The selected PR conversation has an active or restarting ompi owner. Use its existing ompi terminal."
    )
  }
}

function leaseState(probe, sessionId) {
  const { held, unknown } = probe([sessionId]) ?? {}
  if (!Array.isArray(held) || !Array.isArray(unknown) || unknown.includes(sessionId)) {
    throw new Error(
      "OMP could not verify session ownership safely; no lease takeover was attempted."
    )
  }

  return held.includes(sessionId)
}

function requireFreeLease(probe, sessionId) {
  if (leaseState(probe, sessionId)) {
    throw new Error(
      "The selected PR conversation is open in another OMP process. Use its existing terminal."
    )
  }
}

function hasLocalLease(storage, probe, { sessionId, sessionFile }) {
  return leaseState(probe, sessionId) && !storage.isSessionOwnedElsewhere(sessionFile)
}

function claimJournal(storage, probe, session) {
  const release = storage.claimSession(session.sessionId, session.sessionFile)
  if (typeof release !== "function") {
    throw new Error(
      "An OMP conversation acquired another owner or changed on disk; the terminal was not switched."
    )
  }

  try {
    if (hasLocalLease(storage, probe, session)) {
      return release
    }

    throw new Error(
      "OMP could not acquire a verified ownership lease; the terminal was not switched."
    )
  } catch (error) {
    release()
    throw error
  }
}
