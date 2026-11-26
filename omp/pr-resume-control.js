import { realpath } from "node:fs/promises"

import { createPRResumeRequests } from "../cli/pr-resume.js"
import { normalizePRResumeURL } from "../linux/pr-resume.js"
import { claimLaunchPRResume, recordLaunchPRResumeResult } from "./launcher-context.js"
import { isFreshPRResumeSession, resumePullRequest } from "./pr-resume.js"

export function registerPRResumeControl(pi, getRuntime) {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  registerAgentTool(pi, getRuntime, requests)

  return {
    async prepareLaunch(state, ctx, requestedScope) {
      const { launch } = state
      if (!launch.prResume) return

      try {
        if (!(await claimLaunchPRResume(launch))) return

        if (launch.scope.id !== requestedScope.id || launch.restartError) {
          throw new Error("Cannot verify the requested shell PR resume profile and launch options.")
        }

        if ((await realpath(ctx.cwd)) !== launch.prResume.cwd) {
          throw new Error("Shell PR resume requires OMP to start in the requesting directory.")
        }
        if (!isLaunchSource(state, ctx) || !isFreshPRResumeSession(ctx.sessionManager)) {
          throw new Error("Shell PR resume requires a fresh local OMP conversation.")
        }
        if (!hasDraftAccess(ctx) || ctx.ui.getEditorText() !== "") {
          throw new Error("Cannot prepare shell PR resume without an empty OMP editor.")
        }

        ctx.ui.setEditorText(`/ompi resume ${launch.prResume.url}`)
        state.shellPRResumePending = true
        ctx.ui.notify(
          "Press Enter to choose a saved PR conversation, then confirm the switch.",
          "info"
        )
      } catch (error) {
        const result = refused(error)
        await recordResult(launch, ctx, result)
        ctx.ui.notify(result.message, "error")
      }
    },

    async run(url, ctx) {
      const state = getRuntime()
      const freshStart = state?.shellPRResumePending === true && state.launch.prResume.url === url
      const resume = () => resumePullRequest(url, ctx, getRuntime, pi, { freshStart })
      if (!freshStart) {
        return requests.run(url, terminalIdentity(state, ctx), resume)
      }

      if (state.shellPRResumeRunning) {
        throw new Error("Shell PR resume is already in progress in this terminal.")
      }

      state.shellPRResumeRunning = true
      try {
        if (!isLaunchSource(state, ctx)) {
          throw new Error(
            "Shell PR resume can only switch the fresh conversation that opened here."
          )
        }
        const result = await resume()
        await recordResult(state.launch, ctx, result)
        return result
      } catch (error) {
        await recordResult(state.launch, ctx, refused(error))
        throw error
      } finally {
        state.shellPRResumePending = false
        state.shellPRResumeRunning = false
      }
    },
  }
}

function registerAgentTool(pi, getRuntime, requests) {
  const z = pi.zod
  if (typeof pi.registerTool !== "function" || !z) return

  pi.registerTool({
    name: "ompi_pr_resume",
    label: "Resume PR conversation",
    description:
      "Request a PR conversation resume in this managed terminal, or check its result by request ID. A request only prepares /ompi resume in an empty editor; the user must submit it, choose, and confirm. Never use it to switch another terminal.",
    approval: "write",
    parameters: z.object({
      action: z.enum(["request", "status"]),
      url: z.string().optional(),
      requestId: z.string().optional(),
    }),
    async execute(_toolCallId, { action, url, requestId }, _signal, _onUpdate, ctx) {
      const state = getRuntime()
      const { SessionManager } = pi.pi
      let result
      if (
        !state ||
        state.launch.pid !== process.ppid ||
        ctx.agent.kind !== "main" ||
        ctx.mode !== "tui" ||
        state.ctx.sessionManager !== ctx.sessionManager ||
        state.ctx.cwd !== ctx.cwd ||
        typeof SessionManager !== "function" ||
        !(ctx.sessionManager instanceof SessionManager) ||
        ctx.sessionManager.getHeader().origin !== undefined
      ) {
        result = refused("PR resume requires a local launcher-managed OMP terminal.")
      } else {
        const terminal = {
          ...terminalIdentity(state, ctx),
          getDraft: () => ctx.ui.getEditorText?.(),
          setDraft: (text) => ctx.ui.setEditorText(text),
        }
        if (action === "status") {
          result = requests.status(requestId, terminal)
        } else if (
          state.closing ||
          state.pending ||
          state.shutdownRequested ||
          state.exitRequestedSessionId ||
          state.resumingPR ||
          state.shellPRResumePending ||
          !hasDraftAccess(ctx)
        ) {
          result = refused("This terminal cannot prepare a PR resume right now.")
        } else {
          result = requests.request(url, terminal)
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        details: result,
      }
    },
  })
}

function terminalIdentity(state, ctx) {
  return {
    id: state?.instanceId,
    sessionId: ctx.sessionManager?.getSessionId(),
    sessionFile: ctx.sessionManager?.getSessionFile(),
    cwd: ctx.cwd,
  }
}

function isLaunchSource(state, ctx) {
  const { origin } = state
  const { sessionId, sessionFile, cwd } = terminalIdentity(state, ctx)
  return sessionId === origin.sessionId && sessionFile === origin.sessionFile && cwd === origin.cwd
}

function hasDraftAccess(ctx) {
  return typeof ctx.ui.getEditorText === "function" && typeof ctx.ui.setEditorText === "function"
}

function refused(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    status: "refused",
    // Launcher diagnostics can reach a terminal after OMP has shut down.
    // eslint-disable-next-line no-control-regex -- Drop untrusted terminal control bytes.
    message: message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
  }
}

async function recordResult(launch, ctx, result) {
  try {
    await recordLaunchPRResumeResult(launch, result)
  } catch {
    ctx.ui.notify("Could not record the shell PR resume outcome for ompi.", "warning")
  }
}
