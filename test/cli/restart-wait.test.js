import assert from "node:assert/strict"
import test from "node:test"

import { restartInstances } from "../../cli/client.js"
import { waitForRestarts } from "../../cli/restart-wait.js"

const ORIGINAL_ID = "a".repeat(32)
const REPLACEMENT_ID = "b".repeat(32)
const OPERATION_ID = "restart-operation"

function makeRecord(instanceId, pid, lastRestart = null) {
  return {
    instanceId,
    pid,
    cwd: "/project",
    state: "running",
    lastRestart,
  }
}

function acceptedRow(record, operationId = OPERATION_ID) {
  return {
    record,
    instanceId: record.instanceId,
    status: "accepted",
    data: { state: "accepted", operationId },
  }
}

function liveStatus(record, lastRestart = record.lastRestart) {
  return {
    state: "running",
    instanceId: record.instanceId,
    pid: record.pid,
    cwd: record.cwd,
    lastRestart,
    launcherManaged: true,
    canRestart: true,
  }
}

test("when a correlated replacement reuses the original PID, observation completes without replaying restart", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  const replacement = makeRecord(REPLACEMENT_ID, original.pid, {
    operationId: OPERATION_ID,
    previousInstanceId: original.instanceId,
  })
  const sentActions = []
  let restartAccepted = false
  const transport = {
    async readRecords() {
      return restartAccepted ? [replacement] : [original]
    },
    async request(record, request) {
      sentActions.push(request.action)
      if (request.action === "restart-wrapper") {
        restartAccepted = true
        return { ok: true, data: { state: "accepted", operationId: OPERATION_ID } }
      }
      return { ok: true, data: liveStatus(replacement) }
    },
  }

  // Act
  const accepted = await restartInstances(transport, { instanceId: original.instanceId })

  const progressStatuses = []
  const rows = await waitForRestarts(transport, accepted, {
    onProgress(progress) {
      progressStatuses.push(progress[0].status)
    },
  })

  // Assert
  assert.deepEqual(sentActions, ["restart-wrapper", "status"])
  assert.deepEqual(progressStatuses, ["waiting", "restarted"])
  assert.equal(rows[0].status, "restarted")
  assert.equal(rows[0].data.instanceId, replacement.instanceId)
})

test("when replacement metadata does not match, observation ignores the unrelated record", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  const unrelatedRecord = makeRecord(REPLACEMENT_ID, 43, {
    operationId: OPERATION_ID,
    previousInstanceId: "c".repeat(32),
  })
  const controller = new AbortController()
  const cancellation = new Error("stop observing")
  const progressStatuses = []
  let statusRequests = 0
  const transport = {
    async readRecords() {
      return [unrelatedRecord]
    },
    async request() {
      statusRequests += 1
      assert.fail("a record with mismatched correlation must not be probed")
    },
  }

  // Act
  const waiting = waitForRestarts(transport, [acceptedRow(original)], {
    signal: controller.signal,
    onProgress(progress) {
      progressStatuses.push(progress[0].status)
      if (progress[0].status === "restarting") {
        controller.abort(cancellation)
      }
    },
  })

  // Assert
  await assert.rejects(waiting, (error) => error === cancellation)
  assert.deepEqual(progressStatuses, ["waiting", "restarting"])
  assert.equal(statusRequests, 0)
})

test("when a replacement endpoint is closing, observation treats it as transient teardown", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  const replacement = makeRecord(REPLACEMENT_ID, 43, {
    operationId: OPERATION_ID,
    previousInstanceId: original.instanceId,
  })
  const controller = new AbortController()
  const cancellation = new Error("stop after transient teardown")
  const progressStatuses = []
  let statusRequests = 0
  const transport = {
    async readRecords() {
      return [replacement]
    },
    async request(_record, request) {
      assert.equal(request.action, "status")
      statusRequests += 1
      throw Object.assign(new Error("replacement socket closed"), { code: "ECONNRESET" })
    },
  }

  // Act
  const waiting = waitForRestarts(transport, [acceptedRow(original)], {
    signal: controller.signal,
    onProgress(progress) {
      progressStatuses.push(progress[0].status)
      if (progress[0].status === "restarting") {
        controller.abort(cancellation)
      }
    },
  })

  // Assert
  await assert.rejects(waiting, (error) => error === cancellation)
  assert.deepEqual(progressStatuses, ["waiting", "restarting"])
  assert.equal(statusRequests, 1)
})

test("when live status disagrees with discovered restart metadata, observation rejects it", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  const replacement = makeRecord(REPLACEMENT_ID, 43, {
    operationId: OPERATION_ID,
    previousInstanceId: original.instanceId,
  })
  let restartAccepted = false
  const transport = {
    async readRecords() {
      return restartAccepted ? [replacement] : [original]
    },
    async request(_record, request) {
      if (request.action === "restart-wrapper") {
        restartAccepted = true
        return { ok: true, data: { state: "accepted", operationId: OPERATION_ID } }
      }
      return {
        ok: true,
        data: liveStatus(replacement, {
          operationId: OPERATION_ID,
          previousInstanceId: "c".repeat(32),
        }),
      }
    },
  }

  // Act
  const accepted = await restartInstances(transport, { instanceId: original.instanceId })
  const rows = await waitForRestarts(transport, accepted)

  // Assert
  assert.equal(rows[0].status, "unknown")
})

test("when observation is cancelled, a pending replacement probe stops and progress is preserved", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  const replacement = makeRecord(REPLACEMENT_ID, 43, {
    operationId: OPERATION_ID,
    previousInstanceId: original.instanceId,
  })
  const controller = new AbortController()
  const cancellation = new Error("cancel status probe")
  const probeStarted = Promise.withResolvers()
  let latestProgress
  const transport = {
    async readRecords() {
      return [replacement]
    },
    request(_record, request, { signal }) {
      assert.equal(request.action, "status")
      probeStarted.resolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
  }

  // Act
  const waiting = waitForRestarts(transport, [acceptedRow(original)], {
    signal: controller.signal,
    onProgress(progress) {
      latestProgress = progress
    },
  })
  await probeStarted.promise
  controller.abort(cancellation)

  // Assert
  await assert.rejects(waiting, (error) => error === cancellation)
  assert.equal(latestProgress[0].status, "restarting")
})

test("when restart acknowledgements fail or remain unknown, observation does not poll them", async () => {
  // Arrange
  const first = makeRecord(ORIGINAL_ID, 42)
  const second = makeRecord(REPLACEMENT_ID, 43)
  const actions = []
  let recordReads = 0
  const transport = {
    async readRecords() {
      recordReads += 1
      return [first, second]
    },
    async request(record, request) {
      actions.push([record.instanceId, request.action])
      if (record.instanceId === first.instanceId) {
        return { ok: false, error: { code: "NOT_RESTARTABLE", message: "No saved session." } }
      }
      throw Object.assign(new Error("acknowledgement lost"), { code: "ETIMEDOUT" })
    },
  }

  // Act
  const acknowledgements = await restartInstances(transport, { all: true })
  const rows = await waitForRestarts(transport, acknowledgements)

  // Assert
  assert.deepEqual(actions, [
    [first.instanceId, "restart-wrapper"],
    [second.instanceId, "restart-wrapper"],
  ])
  assert.equal(recordReads, 1)
})

test("when a cooperative replacement is resuming, observation waits for continuation submission", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  const replacement = makeRecord(REPLACEMENT_ID, 43, {
    operationId: OPERATION_ID,
    previousInstanceId: original.instanceId,
  })
  let replacementProbes = 0
  const transport = {
    async readRecords() {
      return [replacement]
    },
    async request(_record, request) {
      assert.equal(request.action, "status")
      replacementProbes += 1
      return {
        ok: true,
        data: {
          ...liveStatus(replacement),
          cooperative: {
            operationId: OPERATION_ID,
            phase: replacementProbes === 1 ? "resuming" : "resumed",
            message:
              replacementProbes === 1 ? "Submitting continuation." : "Continuation submitted.",
            requestedAt: 100,
            resumedAt: replacementProbes === 1 ? undefined : 200,
          },
        },
      }
    },
  }
  const progress = []

  // Act
  const rows = await waitForRestarts(transport, [acceptedRow(original)], {
    onProgress(current) {
      progress.push(current[0].status)
    },
  })

  // Assert
  assert.deepEqual(progress, ["waiting", "restarting", "restarted"])
  assert.equal(replacementProbes, 2)
  assert.equal(rows[0].status, "restarted")
  assert.equal(rows[0].data.cooperative.phase, "resumed")
})

test("when cooperative preparation is blocked, observation reports blocked without restarting", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  let actions = 0
  const transport = {
    async readRecords() {
      return [original]
    },
    async request(_record, request) {
      actions += 1
      assert.equal(request.action, "status")
      return {
        ok: true,
        data: {
          ...liveStatus(original),
          cooperative: {
            operationId: OPERATION_ID,
            phase: "blocked",
            message: "Unsafe background job remains active.",
            requestedAt: 100,
          },
        },
      }
    },
  }

  // Act
  const rows = await waitForRestarts(transport, [acceptedRow(original)])

  // Assert
  assert.equal(actions, 1)
  assert.equal(rows[0].status, "blocked")
  assert.match(rows[0].error, /Unsafe background job/)
})

test("when preparation status is unchanged across probes, progress reports only transitions", async () => {
  // Arrange
  const original = makeRecord(ORIGINAL_ID, 42)
  const replacement = makeRecord(REPLACEMENT_ID, 43, {
    operationId: OPERATION_ID,
    previousInstanceId: original.instanceId,
  })
  let reads = 0
  const phases = []
  const transport = {
    async readRecords() {
      reads += 1
      return reads <= 2 ? [original] : [replacement]
    },
    async request(record) {
      return {
        ok: true,
        data: {
          ...liveStatus(record),
          cooperative: {
            operationId: OPERATION_ID,
            phase: record.instanceId === original.instanceId ? "preparing" : "resumed",
            message: "Checkpoint progress.",
            requestedAt: 100,
          },
        },
      }
    },
  }

  // Act
  await waitForRestarts(transport, [acceptedRow(original)], {
    onProgress(current) {
      phases.push(current[0].data?.cooperative?.phase ?? "accepted")
    },
  })

  // Assert
  assert.deepEqual(phases, ["accepted", "preparing", "resumed"])
})

for (const finalPhase of ["resumed", "blocked"]) {
  test(`when a cooperative replacement initially omits progress, observation waits for ${finalPhase}`, async () => {
    // Arrange
    const original = makeRecord(ORIGINAL_ID, 42)
    const replacement = makeRecord(REPLACEMENT_ID, 43, {
      operationId: OPERATION_ID,
      previousInstanceId: original.instanceId,
    })
    const accepted = acceptedRow(original)
    accepted.data.cooperative = { operationId: OPERATION_ID, phase: "preparing" }
    let probes = 0
    const transport = {
      async readRecords() {
        return [replacement]
      },
      async request() {
        probes += 1
        const data = liveStatus(replacement)
        if (probes > 1) {
          data.cooperative = {
            operationId: OPERATION_ID,
            phase: probes === 2 ? "resuming" : finalPhase,
            message: "Continuation outcome.",
          }
        }
        return { ok: true, data }
      },
    }

    // Act
    const rows = await waitForRestarts(transport, [accepted])

    // Assert
    assert.equal(probes, 3)
    assert.equal(rows[0].status, finalPhase === "resumed" ? "restarted" : "blocked")
    assert.equal(rows[0].data.cooperative.phase, finalPhase)
  })
}
