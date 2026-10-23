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
  assert.deepEqual(sent, [[second.instanceId, "restart-wrapper"]])
  assert.equal(result[0].status, "accepted")
  assert.equal(result[0].instanceId, second.instanceId)
})

test("when a unique ID prefix is selected, restart dispatches the full snapshot ID", async () => {
  // Arrange
  const record = { ...first, instanceId: "906e493e".padEnd(32, "0") }
  const client = transport([record, second], async (selectedRecord, request) => {
    assert.equal(selectedRecord.instanceId, record.instanceId)
    assert.equal(request.instanceId, record.instanceId)
    return { ok: true, data: { state: "accepted" } }
  })

  // Act
  const rows = await restartInstances(client, { instanceId: "906e493e" })

  // Assert
  assert.equal(rows[0].instanceId, record.instanceId)
  assert.equal(rows[0].status, "accepted")
})

test("when an ID prefix matches multiple records, restart rejects without dispatching", async () => {
  // Arrange
  const stale = { ...first, instanceId: "ab".padEnd(32, "1") }
  const live = { ...second, instanceId: "ab".padEnd(32, "2") }
  const client = transport([stale, live], async () => assert.fail("must not send a request"))

  // Act
  const rows = await restartInstances(client, { instanceId: "ab" })

  // Assert
  assert.deepEqual(rows, [
    {
      instanceId: "ab",
      status: "failed",
      errorCode: "AMBIGUOUS_INSTANCE",
      error: "Instance ID prefix matches multiple instances; use a longer ID.",
    },
  ])
})

test("when a longer prefix selects one of several instances, restart uses its full ID", async () => {
  // Arrange
  const selected = { ...first, instanceId: "abcdef".padEnd(32, "0") }
  const other = { ...second, instanceId: "abc999".padEnd(32, "0") }
  let dispatched
  const client = transport([selected, other], async (record) => {
    dispatched = record.instanceId
    return { ok: true, data: { state: "accepted" } }
  })

  // Act
  const rows = await restartInstances(client, { instanceId: "abcd" })

  // Assert
  assert.equal(dispatched, selected.instanceId)
  assert.equal(rows[0].instanceId, selected.instanceId)
})

test("when broadcasting, rejection remains distinct from an inconclusive acknowledgement", async () => {
  // Arrange
  const sent = []
  const client = transport([first, second], async (record, request) => {
    sent.push([record.instanceId, request.action])
    if (record.instanceId === first.instanceId) {
      return {
        ok: false,
        error: { code: "WRAPPER_RESTART_UNAVAILABLE", message: "Start a fresh ompi launcher." },
      }
    }
    throw Object.assign(new Error("response timed out"), { code: "ETIMEDOUT", ambiguous: true })
  })

  // Act
  const rows = await restartInstances(client, { all: true })

  // Assert
  assert.equal(rows[0].status, "failed")
  assert.equal(rows[0].errorCode, "WRAPPER_RESTART_UNAVAILABLE")
  assert.equal(rows[1].status, "unknown")
  assert.deepEqual(sent, [
    [first.instanceId, "restart-wrapper"],
    [second.instanceId, "restart-wrapper"],
  ])
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
