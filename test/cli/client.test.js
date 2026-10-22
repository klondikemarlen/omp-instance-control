import assert from "node:assert/strict"
import test from "node:test"

import { formatRows, listInstances, restartInstances } from "../../cli/client.js"

const first = { instanceId: "a".repeat(32), pid: 10, cwd: "/one\npath" }
const second = { instanceId: "b".repeat(32), pid: 11, cwd: "/two" }

function transport(records, request) {
  return {
    async readRecords() {
      return records
    },
    request,
  }
}

test("when the selected instance is absent, restart fails without dispatching a request", async () => {
  // Arrange
  const target = transport([first], async () => assert.fail("must not send a request"))

  // Act / Assert
  assert.deepEqual(await restartInstances(target, { instanceId: second.instanceId }), [
    { instanceId: second.instanceId, status: "failed", error: "No matching instance found." },
  ])
})

test("when one instance is selected, restart dispatches only to that snapshot member", async () => {
  // Arrange
  const sent = []
  const client = transport([first, second], async (record, request) => {
    sent.push([record.instanceId, request.action])
    return {
      ok: true,
      data: { state: "accepted", message: "Settlement deferred." },
    }
  })

  // Act
  const result = await restartInstances(client, { instanceId: second.instanceId })

  // Assert
  assert.deepEqual(sent, [[second.instanceId, "restart"]])
  assert.equal(result[0].status, "accepted")
})

test("when broadcasting, rejection remains distinct from an inconclusive acknowledgement", async () => {
  // Arrange
  const client = transport([first, second], async (record) => {
    if (record.instanceId === first.instanceId) {
      return { ok: false, error: { code: "NOT_RESTARTABLE", message: "No persisted session." } }
    }
    throw Object.assign(new Error("response timed out"), { code: "ETIMEDOUT", ambiguous: true })
  })

  // Act
  const rows = await restartInstances(client, { all: true })

  // Assert
  assert.equal(rows[0].status, "failed")
  assert.equal(rows[0].errorCode, "NOT_RESTARTABLE")
  assert.equal(rows[1].status, "unknown")
})

test("when restart fails, output identifies its project without injecting terminal controls", async () => {
  // Arrange
  const client = transport([first], async () => {
    throw Object.assign(new Error("socket disappeared"), { code: "ECONNREFUSED" })
  })

  // Act
  const rows = await restartInstances(client, { all: true })

  // Assert
  assert.match(formatRows(rows), /unreachable.*one\\u000apath/)
})

test("when listing a vanished endpoint, its outcome remains distinct from a live instance", async () => {
  // Arrange
  const client = transport([first, second], async (record) => {
    if (record.instanceId === first.instanceId) {
      throw Object.assign(new Error("socket disappeared"), { code: "ECONNREFUSED" })
    }
    return { ok: true, data: { state: "running" } }
  })

  // Act
  const rows = await listInstances(client)

  // Assert
  assert.deepEqual(
    rows.map((row) => row.status),
    ["unreachable", "online"]
  )
  assert.match(formatRows(rows), /\\u000apath/)
})
