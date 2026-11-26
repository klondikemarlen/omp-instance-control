import assert from "node:assert/strict"
import test from "node:test"

import { createPRResumeRequests } from "../../cli/pr-resume.js"
import { normalizePRResumeURL } from "../../linux/pr-resume.js"

const url = "https://github.com/owner/repo/pull/116"
const resumeCommand = `/ompi resume ${url}`

function createTerminal(initialDraft = "") {
  let draft = initialDraft
  return {
    id: "managed-terminal",
    sessionId: "source-session",
    sessionFile: "/project/source-session.jsonl",
    cwd: "/project",
    getDraft: () => draft,
    setDraft: (text) => {
      draft = text
    },
  }
}

test("when an agent requests PR resume, only an empty draft is prepared and approval stays pending", () => {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  const terminal = createTerminal()

  const pending = requests.request("https://github.com/Owner/Repo/pull/116", terminal)

  assert.equal(terminal.getDraft(), resumeCommand)
  assert.equal(pending.status, "awaiting-user")
  assert.deepEqual(requests.status(pending.requestId, terminal), pending)
  assert.equal(requests.request(url, terminal).status, "refused")
  assert.equal(terminal.getDraft(), resumeCommand)
})

test("when the draft contains user text or the URL is not a PR, no command is prepared", () => {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  const terminal = createTerminal("User's unfinished thought")

  assert.equal(requests.request(url, terminal).status, "refused")
  assert.equal(terminal.getDraft(), "User's unfinished thought")
  assert.equal(requests.status(undefined, terminal).status, "unknown")

  terminal.setDraft("")
  assert.equal(
    requests.request("https://github.com/owner/repo/issues/116", terminal).status,
    "refused"
  )
  assert.equal(terminal.getDraft(), "")
})

test("when the prepared draft is absent during a status query, the request is not reported as cancelled", () => {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  const terminal = createTerminal()
  const { requestId } = requests.request(url, terminal)

  terminal.setDraft("Unrelated user prompt")

  assert.equal(requests.status(requestId, terminal).status, "not-staged")
  assert.equal(terminal.getDraft(), "Unrelated user prompt")

  terminal.setDraft(resumeCommand)
  assert.equal(requests.status(requestId, terminal).status, "awaiting-user")
})

test("when the matching slash command runs, only its final observed result reports a resume", async () => {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  const terminal = createTerminal()
  const { requestId } = requests.request(url, terminal)
  const switchResult = {
    status: "resumed",
    message: "Resumed the original PR conversation in this terminal.",
  }

  terminal.setDraft("")
  const switchPromise = requests.run(url, terminal, async () => {
    assert.equal(requests.status(requestId, terminal).status, "in-progress")
    terminal.sessionId = "target-session"
    terminal.sessionFile = "/project/target-session.jsonl"
    return switchResult
  })

  assert.deepEqual(await switchPromise, switchResult)
  assert.deepEqual(requests.status(undefined, terminal), {
    requestId,
    status: "resumed",
    message: switchResult.message,
  })
  assert.equal(requests.status(requestId, createTerminalWithAnotherId()).status, "unknown")
  terminal.cwd = "/unrelated"
  assert.equal(requests.status(requestId, terminal).status, "unknown")
})

test("when the slash command is cancelled or cannot safely resume, status preserves that disposition", async () => {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  const terminal = createTerminal()
  const cancelled = requests.request(url, terminal)
  terminal.setDraft("")
  await requests.run(url, terminal, async () => ({
    status: "cancelled",
    message: "PR resume cancelled.",
  }))
  assert.equal(requests.status(cancelled.requestId, terminal).status, "cancelled")

  const refused = requests.request(url, terminal)
  terminal.setDraft("")
  await assert.rejects(
    requests.run(url, terminal, async () => {
      throw new Error("The selected conversation has a live owner.")
    }),
    /live owner/
  )

  assert.deepEqual(requests.status(refused.requestId, terminal), {
    requestId: refused.requestId,
    status: "refused",
    message: "The selected conversation has a live owner.",
  })
})

test("when another conversation becomes active, the old request is no longer staged", () => {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  const terminal = createTerminal()
  const { requestId } = requests.request(url, terminal)

  terminal.sessionId = "another-session"

  assert.equal(requests.status(requestId, terminal).status, "not-staged")
})

test("when a slash command uses another source or URL, it does not consume the staged request", async () => {
  const requests = createPRResumeRequests(normalizePRResumeURL)
  const terminal = createTerminal()
  const { requestId } = requests.request(url, terminal)
  const otherResult = {
    status: "not-found",
    message: "No saved PR conversation found.",
  }

  await requests.run(`${url}1`, terminal, async () => otherResult)
  await requests.run(
    url,
    {
      ...terminal,
      sessionId: "unrelated-session",
    },
    async () => otherResult
  )
  await requests.run(
    url,
    {
      ...terminal,
      sessionFile: "/project/unrelated-session.jsonl",
    },
    async () => otherResult
  )

  assert.equal(requests.status(requestId, terminal).status, "awaiting-user")
})

function createTerminalWithAnotherId() {
  return {
    ...createTerminal(),
    id: "another-managed-terminal",
  }
}
