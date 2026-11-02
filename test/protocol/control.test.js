import assert from "node:assert/strict"
import test from "node:test"

import {
  createMessageRequest,
  createRequest,
  getScope,
  validateRequest,
  validateResponse,
} from "../../protocol/index.js"

const instanceId = "1234567890abcdef1234567890abcdef"

test("when profiles or agent roots differ, they cannot share a control scope", () => {
  // Arrange
  const env = { HOME: "/home/operator", PI_CODING_AGENT_DIR: "/private/agent" }

  // Act
  const normal = getScope({ env })
  const work = getScope({ env, profile: "work" })
  const alternate = getScope({ env: { ...env, PI_CODING_AGENT_DIR: "/another/agent" } })

  // Assert
  assert.notEqual(normal.id, work.id)
  assert.notEqual(normal.id, alternate.id)
  assert.equal(work.agentDir, "/home/operator/.omp/profiles/work/agent")
})

test("when default is explicitly selected, it wins over inherited profiles", () => {
  // Arrange
  const env = { HOME: "/home/operator", OMP_PROFILE: "work", PI_PROFILE: "other" }

  // Act
  const scope = getScope({
    env,
    profile: "default",
  })

  // Assert
  assert.equal(scope.profile, "default")
  assert.equal(scope.agentDir, "/home/operator/.omp/agent")
})

test("when profiles or instance identities contain paths, validation rejects them", () => {
  // Arrange
  const profile = "../other"
  const instance = "../../control"

  // Act / Assert
  assert.throws(() => getScope({ profile }), { code: "INVALID_PROFILE" })
  assert.throws(() => createRequest(instance, "restart"), { code: "INVALID_INSTANCE" })
})

test("when resource-only reload is requested, validation rejects the unsupported action", () => {
  // Arrange
  const request = { version: 1, instanceId, requestId: "r", action: "reload" }

  // Act / Assert
  assert.throws(() => validateRequest(request), { code: "UNSUPPORTED_ACTION" })
})

test("when send payloads are validated, literal text survives and malformed boundaries are rejected", () => {
  // Arrange
  const text = " hi 😀\nthere "

  // Act
  const request = createMessageRequest(instanceId, text, "followUp", "send-1")

  // Assert
  assert.deepEqual(request.message, { text: " hi 😀\nthere ", delivery: "followUp" })
  for (const message of [
    { text: " ", delivery: "steer" },
    { text: "x".repeat(16 * 1024 + 1), delivery: "steer" },
    { text: "ok", delivery: "unknown" },
  ]) {
    assert.throws(
      () => validateRequest({ version: 1, instanceId, requestId: "r", action: "send", message }),
      { code: "INVALID_REQUEST" }
    )
  }
  assert.throws(
    () =>
      validateRequest({
        version: 1,
        instanceId,
        requestId: "r",
        action: "status",
        message: { text: "leak", delivery: "steer" },
      }),
    { code: "INVALID_REQUEST" }
  )
})

test("when responses belong to another launch or request, validation rejects them", () => {
  // Arrange
  const request = createRequest(instanceId, "restart", "request-1")

  // Act / Assert
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
