import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { createRequest } from "../../protocol/index.js"

import { createEventBus, createResumeFixture, waitForPreparation } from "./lifecycle-fixture.js"

test("when a managed terminal is publicly idle, restart persists an idle checkpoint without model delivery", async () => {
  // Arrange
  const idleState = () => ({
    idle: true,
    pending: false,
    snapshot: {
      running: [],
      delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    },
  })
  const fixture = await createResumeFixture({
    lastRestart: null,
    idleState,
    deliverMessage() {
      throw new Error("provider unavailable")
    },
  })
  const request = createRequest(fixture.record.instanceId, "restart")

  try {
    // Act
    const response = await fixture.transport.request(fixture.record, request)
    await fixture.shutdownRequested
    const checkpoint = fixture.extension.branch.find(
      (entry) => entry.data?.operationId === request.requestId
    )?.data
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(response.ok, true)
    assert.equal(fixture.shutdowns, 1)
    assert.deepEqual(fixture.extension.messages, [])
    assert.equal(checkpoint.mode, "idle")
    assert.equal(checkpoint.previousInstanceId, fixture.record.instanceId)
    assert.equal(status.data.cooperative.mode, "idle")
    assert.equal(status.data.cooperative.phase, "restarting")
  } finally {
    await fixture.close()
  }
})

test("when public idle evidence is incomplete or reports work, restart uses active preparation", async (t) => {
  // Arrange
  const states = [
    [
      "active agent turn",
      () => ({
        idle: false,
        pending: false,
        snapshot: {
          running: [],
          delivery: { queued: 0, delivering: false, pendingJobIds: [] },
        },
      }),
    ],
    [
      "pending user message",
      () => ({
        idle: true,
        pending: true,
        snapshot: {
          running: [],
          delivery: { queued: 0, delivering: false, pendingJobIds: [] },
        },
      }),
    ],
    [
      "running async job",
      () => ({
        idle: true,
        pending: false,
        snapshot: {
          running: [{ type: "tool" }],
          delivery: { queued: 0, delivering: false, pendingJobIds: [] },
        },
      }),
    ],
    [
      "queued result delivery",
      () => ({
        idle: true,
        pending: false,
        snapshot: {
          running: [],
          delivery: { queued: 1, delivering: false, pendingJobIds: ["job"] },
        },
      }),
    ],
    ["unknown snapshot", () => ({ idle: true, pending: false, snapshot: undefined })],
  ]

  for (const [name, idleState] of states) {
    await t.test(name, async () => {
      // Arrange
      const fixture = await createResumeFixture({ lastRestart: null, idleState })
      try {
        // Act
        const response = await fixture.transport.request(
          fixture.record,
          createRequest(fixture.record.instanceId, "restart")
        )
        await waitForPreparation(fixture.extension)

        // Assert
        assert.equal(response.ok, true)
        assert.equal(fixture.shutdowns, 0)
        assert.equal(fixture.extension.messages.length, 1)
      } finally {
        await fixture.close()
      }
    })
  }
})

test("when work appears before idle shutdown, the idle checkpoint is not handed off", async () => {
  // Arrange
  let idle = true
  const fixture = await createResumeFixture({
    lastRestart: null,
    idleState: () => ({
      idle,
      pending: false,
      snapshot: {
        running: idle ? [] : [{ type: "tool" }],
        delivery: { queued: 0, delivering: false, pendingJobIds: [] },
      },
    }),
    afterAppendEntry(entry) {
      if (entry.data.mode === "idle") idle = false
    },
  })

  try {
    // Act
    const response = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )
    await waitForPreparation(fixture.extension)
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(response.ok, true)
    assert.equal(fixture.shutdowns, 0)
    assert.equal(fixture.extension.messages.length, 1)
    assert.equal(status.data.cooperative.mode, undefined)
    assert.equal(fixture.extension.branch.filter((entry) => entry.data?.mode === "idle").length, 1)
  } finally {
    await fixture.close()
  }
})

test("when a correlated idle checkpoint is reopened, replacement sends no continuation", async () => {
  // Arrange
  const fixture = await createResumeFixture({
    checkpoint: {
      entryId: "restart-operation:idle:previous-instance",
      mode: "idle",
      checkpoint: "",
    },
  })

  try {
    // Act
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.deepEqual(fixture.extension.messages, [])
    assert.equal(status.data.cooperative.mode, "idle")
    assert.equal(status.data.cooperative.phase, "resumed")
  } finally {
    await fixture.close()
  }
})

test("when duplicate requests race on an idle terminal, one idle checkpoint and shutdown are used", async () => {
  // Arrange
  const idleState = () => ({
    idle: true,
    pending: false,
    snapshot: {
      running: [],
      delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    },
  })
  const fixture = await createResumeFixture({ lastRestart: null, idleState })

  try {
    // Act
    const [first, duplicate] = await Promise.all([
      fixture.transport.request(
        fixture.record,
        createRequest(fixture.record.instanceId, "restart")
      ),
      fixture.transport.request(
        fixture.record,
        createRequest(fixture.record.instanceId, "restart")
      ),
    ])
    await fixture.shutdownRequested

    // Assert
    assert.equal(first.ok, true)
    assert.equal(duplicate.ok, true)
    assert.equal(first.data.operationId, duplicate.data.operationId)
    assert.equal(fixture.extension.branch.filter((entry) => entry.data?.mode === "idle").length, 1)
    assert.equal(fixture.shutdowns, 1)
    assert.deepEqual(fixture.extension.messages, [])
  } finally {
    await fixture.close()
  }
})

test("when context changes during idle checkpoint persistence, no prompt or shutdown is used", async () => {
  // Arrange
  let fixture
  fixture = await createResumeFixture({
    lastRestart: null,
    idleState: () => ({
      idle: true,
      pending: false,
      snapshot: {
        running: [],
        delivery: { queued: 0, delivering: false, pendingJobIds: [] },
      },
    }),
    afterAppendEntry(entry) {
      if (entry.data.mode === "idle") fixture.ctx.cwd = `${fixture.ctx.cwd}/changed`
    },
  })

  try {
    // Act
    const response = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )

    // Assert
    assert.equal(response.ok, true)
    assert.equal(fixture.shutdowns, 0)
    assert.deepEqual(fixture.extension.messages, [])
  } finally {
    await fixture.close()
  }
})

test("when explicit exit arrives during idle checkpoint persistence, no preparation is sent", async () => {
  // Arrange
  const events = createEventBus()
  let fixture
  fixture = await createResumeFixture({
    lastRestart: null,
    events,
    idleState: () => ({
      idle: true,
      pending: false,
      snapshot: {
        running: [],
        delivery: { queued: 0, delivering: false, pendingJobIds: [] },
      },
    }),
    afterAppendEntry(entry) {
      if (entry.data.mode === "idle") {
        events.emit("omp-exit-command:exit-requested", { sessionId: "resumed-session" })
      }
    },
  })

  try {
    // Act
    const response = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )

    // Assert
    assert.equal(response.ok, true)
    assert.equal(fixture.shutdowns, 0)
    assert.deepEqual(fixture.extension.messages, [])
  } finally {
    await fixture.close()
  }
})

test("when idle checkpoint persistence fails, restart blocks without a model turn", async () => {
  // Arrange
  const fixture = await createResumeFixture({
    lastRestart: null,
    idleState: () => ({
      idle: true,
      pending: false,
      snapshot: {
        running: [],
        delivery: { queued: 0, delivering: false, pendingJobIds: [] },
      },
    }),
    afterAppendEntry(entry) {
      if (entry.data.mode === "idle") throw new Error("transcript persistence failed")
    },
  })

  try {
    // Act
    const response = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(response.ok, true)
    assert.equal(fixture.shutdowns, 0)
    assert.deepEqual(fixture.extension.messages, [])
    assert.equal(status.data.cooperative.phase, "blocked")
    assert.match(status.data.cooperative.message, /transcript persistence failed/)
  } finally {
    await fixture.close()
  }
})

test("when an idle checkpoint leaves the active branch during persistence, restart blocks without a model turn", async () => {
  // Arrange
  let fixture
  fixture = await createResumeFixture({
    lastRestart: null,
    idleState: () => ({
      idle: true,
      pending: false,
      snapshot: {
        running: [],
        delivery: { queued: 0, delivering: false, pendingJobIds: [] },
      },
    }),
    afterAppendEntry(entry) {
      if (entry.data.mode !== "idle") return
      const index = fixture.extension.branch.indexOf(entry)
      fixture.extension.branch.splice(index, 1)
    },
  })

  try {
    // Act
    const response = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )
    const status = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "status")
    )

    // Assert
    assert.equal(response.ok, true)
    assert.equal(fixture.shutdowns, 0)
    assert.deepEqual(fixture.extension.messages, [])
    assert.equal(status.data.cooperative.phase, "blocked")
  } finally {
    await fixture.close()
  }
})

test("when shutdown starts during idle checkpoint persistence, no late preparation is sent", async () => {
  // Arrange
  let fixture
  let closing
  fixture = await createResumeFixture({
    lastRestart: null,
    idleState: () => ({
      idle: true,
      pending: false,
      snapshot: {
        running: [],
        delivery: { queued: 0, delivering: false, pendingJobIds: [] },
      },
    }),
    afterAppendEntry(entry) {
      if (entry.data.mode === "idle") {
        closing = fixture.handlers.get("session_shutdown")({}, fixture.ctx)
      }
    },
  })

  try {
    // Act
    const response = await fixture.transport.request(
      fixture.record,
      createRequest(fixture.record.instanceId, "restart")
    )
    await closing

    // Assert
    assert.equal(response.ok, true)
    assert.deepEqual(fixture.extension.messages, [])
    assert.equal(fixture.shutdowns, 0)
    await assert.rejects(
      readFile(path.join(process.env.OMP_INSTANCE_CONTROL_LAUNCH_DIR, "handoff.json")),
      { code: "ENOENT" }
    )
  } finally {
    await fixture.close()
  }
})
