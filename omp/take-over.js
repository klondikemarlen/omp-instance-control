import { prepareResumeCommand } from "../linux/take-over.js"

export async function prepareTakeover(ctx) {
  const sessionManager = ctx?.sessionManager
  if (!sessionManager) {
    throw new Error("The current session cannot be resumed.")
  }

  const sessionId = sessionManager.getSessionId()
  const sessionFile = sessionManager.getSessionFile()
  const cwd = ctx.cwd
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("The current session has no persisted session identity.")
  }

  const command = await prepareResumeCommand({ sessionFile, cwd })
  if (
    ctx.sessionManager.getSessionId() !== sessionId ||
    ctx.sessionManager.getSessionFile() !== sessionFile ||
    ctx.cwd !== cwd
  ) {
    throw new Error("The active session changed while preparing its resume command.")
  }

  return command
}
