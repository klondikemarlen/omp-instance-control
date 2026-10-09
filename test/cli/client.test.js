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

test("restart requires explicit unambiguous selection and fails missing targets", async () => {
  const target = transport([first], async () => assert.fail("must not send a request"))
  await assert.rejects(restartInstances(target), /Choose exactly one/)
  await assert.rejects(
    restartInstances(target, { all: true, instanceId: first.instanceId }),
    /Choose exactly one/
  )
  assert.deepEqual(await restartInstances(target, { instanceId: second.instanceId }), [
    { instanceId: second.instanceId, status: "failed", error: "No matching instance found." },
  ])
})

test("one-target restart dispatches only to that snapshot member", async () => {
  const sent = []
  const client = transport([first, second], async (record, request) => {
    sent.push([record.instanceId, request.action])
    return {
      ok: true,
      data: { state: "accepted", message: "Settlement deferred." },
    }
  })
  const result = await restartInstances(client, { instanceId: second.instanceId })
  assert.deepEqual(sent, [[second.instanceId, "restart"]])
  assert.equal(result[0].status, "accepted")
})

test("all-target restart preserves business failures, unreachable and unknown outcomes", async () => {
  const client = transport([first, second], async (record) => {
    if (record.instanceId === first.instanceId) {
      return { ok: false, error: { code: "NOT_RESTARTABLE", message: "No persisted session." } }
    }
    throw Object.assign(new Error("response timed out"), { code: "ETIMEDOUT", ambiguous: true })
  })
  assert.deepEqual(await restartInstances(client, { all: true }), [
    {
      instanceId: first.instanceId,
      status: "failed",
      error: "No persisted session.",
      errorCode: "NOT_RESTARTABLE",
    },
    { instanceId: second.instanceId, status: "unknown", error: "response timed out" },
  ])
})

test("listing probes each record and distinguishes vanished endpoints", async () => {
  const client = transport([first, second], async (record) => {
    if (record.instanceId === first.instanceId) {
      throw Object.assign(new Error("socket disappeared"), { code: "ECONNREFUSED" })
    }
    return { ok: true, data: { state: "running" } }
  })
  const rows = await listInstances(client)
  assert.deepEqual(
    rows.map((row) => row.status),
    ["unreachable", "online"]
  )
  assert.match(formatRows(rows), /\\u000apath/)
})
