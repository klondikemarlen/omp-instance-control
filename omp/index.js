import { randomBytes } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { formatRows, listInstances, restartInstances } from "../cli/client.js"
import { createTransport } from "../linux/transport.js"
import { getScope, ProtocolError, PROTOCOL_VERSION } from "../protocol/index.js"
import { readLauncherContext, writeRestartHandoff } from "./launcher-context.js"

function isMainTerminal(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui"
}

async function hasPersistedSession(ctx) {
  const file = ctx.sessionManager.getSessionFile()
  if (!file) return false
  try {
    return (await stat(file)).isFile()
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

export default async function instanceControl(pi) {
  const launch = await readLauncherContext()
  if (
    launch &&
    (await realpath(launch.extensionPath)) !== (await realpath(fileURLToPath(import.meta.url)))
  )
    return

  let runtime

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
    }
  }

  async function refresh(ctx) {
    if (!runtime || runtime.closing || !isMainTerminal(ctx)) return
    runtime.ctx = ctx
    const state = runtime
    const value = record(ctx)
    const pendingWrite = state.recordWrite ?? Promise.resolve()
    state.recordWrite = pendingWrite.catch(() => {}).then(() => state.transport.writeRecord(value))
    await state.recordWrite
  }

  async function handleRequest(request) {
    if (runtime.closing)
      throw new ProtocolError("INSTANCE_CLOSING", "This instance is shutting down.")
    const ctx = runtime.ctx
    if (request.action === "status") {
      return {
        data: {
          ...record(ctx),
          canRestart: !runtime.launch.restartError && (await hasPersistedSession(ctx)),
        },
      }
    }
    if (process.ppid !== runtime.launch.pid) {
      throw new ProtocolError("LAUNCHER_GONE", "The owning launcher is no longer attached.")
    }
    if (runtime.launch.restartError) {
      throw new ProtocolError("RESTART_ARGUMENTS_UNAVAILABLE", runtime.launch.restartError)
    }
    if (!(await hasPersistedSession(ctx))) {
      throw new ProtocolError(
        "SESSION_UNAVAILABLE",
        "Restart requires a persisted session; ephemeral and never-materialized sessions cannot be resumed."
      )
    }

    const firstRequest = !runtime.pending
    if (firstRequest) {
      runtime.pending = request.requestId
      runtime.admission = refresh(ctx)
    }
    const admission = runtime.admission
    try {
      await admission
    } catch (error) {
      if (runtime.admission === admission) {
        runtime.pending = null
        runtime.admission = undefined
      }
      throw error
    }
    return {
      data: {
        state: "accepted",
        operationId: runtime.pending,
        message: "Restart requested; OMP will shut down at its settled boundary.",
      },
      afterReply: () => {
        if (!runtime || runtime.shutdownRequested) return
        runtime.shutdownRequested = true
        runtime.ctx.shutdown()
      },
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isMainTerminal(ctx) || runtime) return
    try {
      if (!launch) {
        ctx.ui.setStatus("instance-control", "instances: launcher required")
        return
      }
      for (const [name, expectedType] of Object.entries(launch.flagTypes ?? {})) {
        const value = pi.getFlag?.(name)
        if (value !== undefined && typeof value !== expectedType) {
          launch.restartError = `Extension flag --${name} changes built-in argument consumption; controlled restart is unavailable to prevent startup-message replay.`
          break
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
      }
      runtime.server = await transport.serve(runtime.instanceId, handleRequest, (error) => {
        ctx.ui.notify(`Instance control: ${error.message}`, "error")
      })
      await refresh(ctx)
      ctx.ui.setStatus("instance-control", `instance ${runtime.instanceId.slice(0, 8)}`)
    } catch (error) {
      if (runtime) {
        await runtime.server?.close()
        await runtime.transport.removeRecord(runtime.instanceId)
        runtime = undefined
      }
      ctx.ui.notify(`Instance control unavailable: ${error.message}`, "error")
    }
  })

  pi.on("session_switch", async (_event, ctx) => refresh(ctx))
  pi.on("session_branch", async (_event, ctx) => refresh(ctx))
  pi.on("agent_end", async (_event, ctx) => refresh(ctx))

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!runtime || !isMainTerminal(ctx)) return
    const state = runtime
    state.closing = true
    try {
      if (runtime.pending) {
        writeRestartHandoff(runtime.launch, runtime.pending, runtime.instanceId, ctx)
      }
    } finally {
      await state.recordWrite?.catch(() => {})
      await state.server.close()
      await state.transport.removeRecord(state.instanceId)
      runtime = undefined
    }
  })

  pi.registerCommand("instances", {
    description: "List launcher-managed Linux instances or request scoped restart",
    handler: async (args, ctx) => {
      if (!isMainTerminal(ctx) || !runtime) {
        ctx.ui.notify("Instance control requires a main Linux terminal started with ompi.", "error")
        return
      }
      try {
        const { values, positionals } = parseArgs({
          args: args.trim() ? args.trim().split(/\s+/) : [],
          options: { all: { type: "boolean" }, instance: { type: "string" } },
          allowPositionals: true,
        })
        const action = positionals[0] ?? "list"
        if (positionals.length > 1 || (action !== "list" && action !== "restart")) {
          throw new Error(
            "Usage: /instances list | /instances restart --all | /instances restart --instance ID"
          )
        }
        if (action === "list" && (values.all || values.instance)) {
          throw new Error("Target selectors apply only to restart.")
        }
        const rows =
          action === "list"
            ? await listInstances(runtime.transport)
            : await restartInstances(runtime.transport, {
                all: values.all,
                instanceId: values.instance,
              })
        ctx.ui.notify(
          formatRows(rows),
          rows.some((row) => ["failed", "unknown", "unreachable"].includes(row.status))
            ? "warning"
            : "info"
        )
      } catch (error) {
        ctx.ui.notify(error.message, "error")
      }
    },
  })
}
