import { randomUUID } from "node:crypto"

const AWAITING_USER = "awaiting-user"
const IN_PROGRESS = "in-progress"

// One managed terminal can stage one pending request and retain its latest result.
// Neither a request nor a status check can invoke the resume operation.
export function createPRResumeRequests(normalizePRResumeURL) {
  let pending
  let latest

  function finish(status, message) {
    latest = {
      terminalId: pending.terminalId,
      cwd: pending.cwd,
      result: {
        requestId: pending.result.requestId,
        status,
        message,
      },
    }
    pending = undefined
  }

  function settleChangedSource(terminal) {
    if (
      pending?.result.status === AWAITING_USER &&
      pending.terminalId === terminal.id &&
      !matchesSource(pending, terminal)
    ) {
      finish("not-staged", "The original conversation changed before PR resume started.")
    }
  }

  function request(url, terminal) {
    const canonicalURL = normalizePRResumeURL(url)
    if (!canonicalURL) {
      return refused("Enter a full GitHub pull request URL.")
    }

    settleChangedSource(terminal)
    const draft = terminal.getDraft()
    if (pending && (pending.result.status === IN_PROGRESS || draft === pending.command)) {
      return refused("A PR resume request is already pending in this terminal.")
    }

    if (draft !== "") {
      return refused("The current editor is not empty. The existing draft was not changed.")
    }

    const command = `/ompi resume ${canonicalURL}`
    terminal.setDraft(command)
    if (terminal.getDraft() !== command) {
      return refused("OMP did not prepare the PR resume command in this terminal.")
    }

    if (pending) {
      finish("not-staged", "A new PR resume request replaced the absent prepared draft.")
    }

    const result = {
      requestId: randomUUID(),
      status: AWAITING_USER,
      message:
        "PR resume is pending. The operator must submit the prepared command, choose a conversation, and confirm. Nothing has switched yet.",
    }
    pending = {
      terminalId: terminal.id,
      sessionId: terminal.sessionId,
      sessionFile: terminal.sessionFile,
      cwd: terminal.cwd,
      url: canonicalURL,
      command,
      result,
    }
    return result
  }

  function status(requestId, terminal) {
    settleChangedSource(terminal)
    for (const receipt of [pending, latest]) {
      if (!receipt || receipt.terminalId !== terminal.id || receipt.cwd !== terminal.cwd) {
        continue
      }

      if (requestId === undefined || receipt.result.requestId === requestId) {
        if (
          receipt === pending &&
          receipt.result.status === AWAITING_USER &&
          terminal.getDraft() !== receipt.command
        ) {
          return {
            requestId: receipt.result.requestId,
            status: "not-staged",
            message:
              "The prepared command is not visible in the editor. No submission or refusal was observed.",
          }
        }

        return receipt.result
      }
    }

    return {
      status: "unknown",
      message: "No matching PR resume request is available in this managed terminal.",
    }
  }

  async function run(url, terminal, resume) {
    if (
      pending?.result.status !== AWAITING_USER ||
      !matchesSource(pending, terminal) ||
      pending.url !== normalizePRResumeURL(url)
    ) {
      return resume()
    }

    pending.result = {
      requestId: pending.result.requestId,
      status: IN_PROGRESS,
      message: "The prepared PR resume command is running; resumption is not confirmed yet.",
    }

    try {
      const result = await resume()
      finish(result.status, result.message)
      return result
    } catch (error) {
      finish("refused", error.message)
      throw error
    }
  }

  return {
    request,
    status,
    run,
  }
}

function matchesSource(request, terminal) {
  return (
    request.terminalId === terminal.id &&
    request.sessionId === terminal.sessionId &&
    request.sessionFile === terminal.sessionFile &&
    request.cwd === terminal.cwd
  )
}

function refused(message) {
  return {
    status: "refused",
    message,
  }
}
