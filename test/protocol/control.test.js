import assert from "node:assert/strict"
import test from "node:test"

import { createRequest, getScope, validateRequest, validateResponse } from "../../protocol/index.js"

const instanceId = "1234567890abcdef1234567890abcdef"

test("profiles and agent-root overrides cannot share a control scope", () => {
  const env = { HOME: "/home/operator", PI_CODING_AGENT_DIR: "/private/agent" }
  const normal = getScope({ env })
  const work = getScope({ env, profile: "work" })
  const alternate = getScope({ env: { ...env, PI_CODING_AGENT_DIR: "/another/agent" } })
  assert.notEqual(normal.id, work.id)
  assert.notEqual(normal.id, alternate.id)
  assert.equal(work.agentDir, "/home/operator/.omp/profiles/work/agent")
})

test("explicit default profile wins over inherited profile selection", () => {
  const scope = getScope({
    env: { HOME: "/home/operator", OMP_PROFILE: "work", PI_PROFILE: "other" },
    profile: "default",
  })
  assert.equal(scope.profile, "default")
  assert.equal(scope.agentDir, "/home/operator/.omp/agent")
})

test("path-like profiles and instance identities are rejected", () => {
  assert.throws(() => getScope({ profile: "../other" }), { code: "INVALID_PROFILE" })
  assert.throws(() => createRequest("../../control", "restart"), { code: "INVALID_INSTANCE" })
})

test("resource-only reload cannot masquerade as supported restart", () => {
  assert.throws(
    () => validateRequest({ version: 1, instanceId, requestId: "r", action: "reload" }),
    { code: "UNSUPPORTED_ACTION" }
  )
})

test("responses from another launch or request are not accepted", () => {
  const request = createRequest(instanceId, "restart", "request-1")
  assert.throws(
    () =>
      validateResponse(
        {
          version: 1,
          instanceId: "abcdef1234567890abcdef1234567890",
          requestId: request.requestId,
          ok: true,
          data: {},
        },
        request
      ),
    { code: "WRONG_INSTANCE" }
  )
  assert.throws(
    () =>
      validateResponse(
        { version: 1, instanceId, requestId: "another-request", ok: true, data: {} },
        request
      ),
    { code: "WRONG_INSTANCE" }
  )
})
