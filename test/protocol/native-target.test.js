import assert from "node:assert/strict"
import test from "node:test"

import { createRequest, validateRequest } from "../../protocol/index.js"

const instanceId = "1234567890abcdef1234567890abcdef"

test("when a pinned native identity accompanies a child-only restart, admission rejects it", () => {
  // Arrange
  const request = {
    ...createRequest(instanceId, "restart"),
    nativeTarget: {
      device: "1",
      inode: "2",
      size: "4096",
      modifiedNs: "1793000000000000000",
    },
  }

  // Act & Assert
  assert.throws(() => validateRequest(request), { code: "INVALID_REQUEST" })
})

test("when pinned native identity numbers are ambiguous or out of range, admission rejects them", () => {
  // Arrange
  const nativeTarget = {
    device: "1",
    inode: "2",
    size: "4096",
    modifiedNs: "1793000000000000000",
  }
  const invalidTargets = [
    { ...nativeTarget, inode: "18446744073709551616" },
    { ...nativeTarget, size: "-1" },
    { ...nativeTarget, device: "01" },
    { ...nativeTarget, modifiedNs: "9223372036854775808" },
    { ...nativeTarget, modifiedNs: "-0" },
  ]

  // Act & Assert
  for (const target of invalidTargets) {
    assert.throws(
      () =>
        validateRequest({ ...createRequest(instanceId, "restart-wrapper"), nativeTarget: target }),
      { code: "INVALID_REQUEST" }
    )
  }
})
