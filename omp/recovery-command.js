import { listInstances } from "../cli/client.js"
import { getScope } from "../protocol/index.js"
import { createTransport } from "../linux/transport.js"
import { listSavedSessions, readRestoreSnapshot, saveRestoreName } from "../linux/restore.js"
import { prepareNamedRestoreCommand, prepareSlotRestoreCommand } from "../linux/take-over.js"
import {
  captureRecoveryCheckpoint,
  exportRecoveryCommands,
  importLegacyRecovery,
  listRecoveryCheckpoints,
  listRecoverySessions,
} from "../linux/recovery.js"

export function getRestoreScope(profile, launchScope) {
  const selectedProfile = profile === "" ? undefined : profile
  if (launchScope && (selectedProfile === undefined || selectedProfile === launchScope.profile)) {
    return launchScope
  }
  const env = { ...process.env }
  if (launchScope) {
    env.PI_CONFIG_DIR = launchScope.configRoot
    // A named-profile launch anchor is not a default-profile agent-directory override.
    if (launchScope.profile !== "default" && env.PI_CODING_AGENT_DIR === launchScope.agentDir) {
      delete env.PI_CODING_AGENT_DIR
    }
  }
  return getScope({ cwd: process.cwd(), profile: selectedProfile, env })
}

function snapshotMatchesRecord(snapshot, record) {
  return (
    record?.restoreId === snapshot.restoreId &&
    record?.sessionId === snapshot.sessionId &&
    record?.sessionFile === snapshot.sessionFile &&
    record?.cwd === snapshot.cwd
  )
}

function recordMatchesStatus(record, status) {
  return (
    record?.instanceId === status?.instanceId &&
    record?.scope === status?.scope &&
    record?.pid === status?.pid &&
    record?.restoreId === status?.restoreId &&
    record?.cwd === status?.cwd &&
    record?.sessionId === status?.sessionId &&
    record?.sessionFile === status?.sessionFile &&
    record?.launcherManaged === status?.launcherManaged
  )
}

function sameSnapshot(first, second) {
  return JSON.stringify(first) === JSON.stringify(second)
}

function safeTerminalText(value) {
  return String(value).replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
}

export function createRestoreCommand(pi, { getRuntime, refreshCompletionIds }) {
  async function saveRestoreBinding(ctx, name, values) {
    const runtime = getRuntime()
    const scope = getRestoreScope(values.profile, runtime?.launch.scope)
    let instanceId = values.instance
    if (!instanceId) {
      if (!runtime || runtime.launch.scope.id !== scope.id) {
        throw new Error("Saving without --instance requires the current managed instance.")
      }
      instanceId = runtime.instanceId
    }

    const transport = await createTransport(scope)
    const rows = await listInstances(transport)
    const row = rows.find((candidate) => candidate.record.instanceId === instanceId)
    if (!row) {
      throw new Error(`Managed instance ${instanceId} was not found in this scope.`)
    }
    if (row.status !== "online") {
      throw new Error(
        `Managed instance ${instanceId} could not be verified: ${row.error ?? row.status}`
      )
    }
    if (
      row.data.instanceId !== instanceId ||
      row.data.scope !== scope.id ||
      !recordMatchesStatus(row.record, row.data)
    ) {
      throw new Error("The live instance identity changed while it was being verified.")
    }
    if (runtime?.instanceId === instanceId && runtime.launch.restartError) {
      throw new Error(runtime.launch.restartError)
    }
    if (row.data.launcherManaged !== true) {
      throw new Error("Only launcher-managed instances can be named.")
    }
    if (row.data.canRestart !== true) {
      throw new Error("This managed instance has no safely resumable persisted session.")
    }
    const restoreId = row.data.restoreId
    if (!/^[a-f0-9]{32}$/.test(restoreId ?? "")) {
      throw new Error("This managed instance has no named-restore identity.")
    }

    const snapshot = await readRestoreSnapshot(scope, restoreId)
    if (!snapshot) {
      throw new Error("This managed instance has no persisted restore snapshot.")
    }
    if (!snapshotMatchesRecord(snapshot, row.data)) {
      throw new Error("The managed session changed while its restore state was being checked.")
    }

    await saveRestoreName(scope, name, restoreId, { expectedSnapshot: snapshot })
    await refreshCompletionIds(ctx, values.profile)
    ctx.ui.notify(`Saved restore name '${name}' for instance ${instanceId.slice(0, 12)}.`, "info")
  }

  async function restoreSavedSession(ctx, name, scope) {
    const saved = await listSavedSessions(scope)
    if (saved.length === 0) {
      ctx.ui.notify("No named sessions are saved in this scope.", "info")
      return
    }
    const selected = saved.find((entry) => entry.name === name)
    if (!selected) {
      throw new Error(`No saved session is named '${safeTerminalText(name)}'.`)
    }
    if (!selected.session) {
      throw new Error(
        `Named session '${safeTerminalText(selected.name)}' is unavailable: ${safeTerminalText(selected.unavailable)}`
      )
    }
    const session = await readRestoreSnapshot(scope, selected.session.restoreId)
    if (!session || !sameSnapshot(session, selected.session)) {
      throw new Error("The named session changed while it was being selected; run restore again.")
    }
    const command = await prepareNamedRestoreCommand(scope, selected.name, session)
    const confirmed = await ctx.ui.confirm(
      "Restore Named Session",
      `After OMP exits, paste this command in your shell to restore the exact saved session:\n\n${command}\n\nExit gracefully? No restore process starts from inside OMP.`
    )
    if (!confirmed) return

    const latestSaved = await listSavedSessions(scope)
    const latest = latestSaved.find((entry) => entry.name === selected.name)
    if (!latest || !sameSnapshot(latest.session, selected.session)) {
      throw new Error("The named session changed while confirmation was open; run restore again.")
    }
    const latestSession = await readRestoreSnapshot(scope, latest.session.restoreId)
    if (!latestSession || !sameSnapshot(latestSession, latest.session)) {
      throw new Error("The named session is no longer safely restorable.")
    }
    if ((await prepareNamedRestoreCommand(scope, latest.name, latestSession)) !== command) {
      throw new Error("The restore command changed while confirmation was open; run restore again.")
    }

    pi.appendEntry("ompi-restore", { name: selected.name, command })
    ctx.shutdown()
  }

  return async function restoreCommand(ctx, { operation, name, values }) {
    const scope = getRestoreScope(values.profile, getRuntime()?.launch.scope)
    if (operation === "save") {
      await saveRestoreBinding(ctx, name, values)
      return
    }
    if (operation === "menu" || operation === "recovery-slot" || operation === "recovery-from") {
      let candidates = []
      let selected
      if (operation === "recovery-slot") {
        const session = await readRestoreSnapshot(scope, values.slot)
        if (!session) throw new Error(`Restore slot ${values.slot} is unavailable.`)
        selected = { restoreId: values.slot, session }
      } else {
        if (operation === "recovery-from") {
          candidates = await listRecoverySessions(scope, { checkpointId: values.from })
        } else {
          candidates = await listRecoverySessions(scope)
        }
        if (candidates.length === 0) {
          ctx.ui.notify("No recovery candidates are available.", "info")
          return
        }
        const choices = candidates.map((item, index) => {
          const label = item.name ?? item.restoreId ?? "legacy"
          const location = item.session?.cwd ?? item.unavailable ?? "legacy export only"
          return `${index + 1}. ${label} — ${location}`
        })
        const choice = await ctx.ui.select("Choose a recoverable session", choices)
        if (!choice) return
        selected = candidates[choices.indexOf(choice)]
      }
      if (selected.legacy) {
        ctx.ui.notify(await exportRecoveryCommands(scope, [selected]), "info")
        return
      }
      if (!selected.session || !selected.restoreId) {
        throw new Error(
          selected.unavailable ??
            "This imported legacy record is unowned and cannot be launched automatically."
        )
      }
      const snapshot = await readRestoreSnapshot(scope, selected.restoreId)
      if (!snapshot || !sameSnapshot(snapshot, selected.session)) {
        throw new Error("The recovery session changed while it was being selected.")
      }
      const command = await prepareSlotRestoreCommand(scope, selected.restoreId, snapshot)
      const confirmed = await ctx.ui.confirm(
        "Restore Managed Session",
        `Copy this command. After OMP exits, paste it in your shell:\n\n${command}\n\nExit gracefully?`
      )
      if (!confirmed) return
      let latest
      if (operation === "recovery-slot") {
        const session = await readRestoreSnapshot(scope, selected.restoreId)
        latest = session ? [{ restoreId: selected.restoreId, session }] : []
      } else if (operation === "recovery-from") {
        latest = await listRecoverySessions(scope, { checkpointId: values.from })
      } else {
        latest = await listRecoverySessions(scope)
      }
      const current = latest.find((item) => item.restoreId === selected.restoreId)
      if (!current?.session || !sameSnapshot(current.session, snapshot)) {
        throw new Error("The recovery session changed while confirmation was open.")
      }
      const updatedCommand = await prepareSlotRestoreCommand(
        scope,
        current.restoreId,
        current.session
      )
      if (updatedCommand !== command) {
        throw new Error("The prepared restore command changed while confirmation was open.")
      }
      pi.appendEntry("ompi-restore", { restoreId: selected.restoreId, command })
      ctx.shutdown()
      return
    }
    if (operation?.startsWith("recovery-")) {
      const recoveryOperation = operation.slice("recovery-".length)
      if (recoveryOperation === "checkpoint") {
        const checkpoint = await captureRecoveryCheckpoint(scope, { reason: "manual" })
        ctx.ui.notify(checkpoint.checkpointId, "info")
      } else if (recoveryOperation === "history") {
        const history = await listRecoveryCheckpoints(scope)
        ctx.ui.notify(
          values.json
            ? JSON.stringify(history)
            : history
                .map(
                  (item) =>
                    `${item.checkpointId} ${item.createdAt} ${item.reason} (${item.entries.length} managed)`
                )
                .join("\n") || "No recovery checkpoints.",
          "info"
        )
      } else if (recoveryOperation === "import-legacy") {
        const imported = await importLegacyRecovery(scope, values["import-legacy"] || undefined)
        ctx.ui.notify(
          JSON.stringify(
            imported.map((item) => ({
              checkpointId: item.checkpointId,
              warnings: item.warnings ?? [],
              unavailable: (item.legacy ?? [])
                .filter((entry) => entry.unavailable)
                .map((entry) => ({
                  sessionId: entry.sessionId,
                  reason: entry.unavailable,
                })),
            }))
          ),
          "info"
        )
      } else {
        if (recoveryOperation === "export") {
          const sessions = await listRecoverySessions(scope, { checkpointId: values.from })
          ctx.ui.notify(await exportRecoveryCommands(scope, sessions), "info")
        } else {
          const sessions = await listRecoverySessions(scope, { checkpointId: values.from })
          const output = values.json
            ? JSON.stringify(sessions)
            : sessions
                .map((item) => {
                  const label = item.name ?? item.restoreId ?? "legacy"
                  const location =
                    item.session?.cwd ??
                    item.unavailable ??
                    item.legacy?.sessionFile ??
                    "unavailable"
                  return `${label} — ${location}`
                })
                .join("\n") || "No recovery candidates."
          ctx.ui.notify(output, "info")
        }
      }
      await refreshCompletionIds(ctx, values.profile)
      return
    }
    await restoreSavedSession(ctx, name, scope)
    return
  }
}
