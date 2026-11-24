import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { writePrivateJson } from "../../linux/transport.js"
import instanceControl from "../../omp/index.js"
import { createRequest } from "../../protocol/index.js"
import { createEventBus, createExtensionApi } from "./lifecycle-fixture.js"
import { createRestartDirectoryFixture, observationFile } from "./restart-directory-fixture.js"

test("when OMP is asked to shut down, the private observation and pointer are already visible", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture()
  const { ctx, launchDirectory, record, scope, shutdownRequested, transport } = fixture
  const request = createRequest(record.instanceId, "restart")
  const snapshotFile = observationFile(scope, record.instanceId)
  const markerFile = path.join(launchDirectory, "restart-observation.json")
  const originalShutdown = ctx.shutdown
  let snapshot
  let marker
  ctx.shutdown = () => {
    try {
      snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"))
      marker = JSON.parse(readFileSync(markerFile, "utf8"))
    } finally {
      originalShutdown()
    }
  }

  try {
    // Act
    const accepted = await transport.request(record, request)
    await shutdownRequested.promise

    // Assert
    assert.equal(accepted.data.operationId, request.requestId)
    assert.deepEqual(marker, {
      operationId: request.requestId,
      previousInstanceId: record.instanceId,
    })
    assert.deepEqual(snapshot, {
      ...marker,
      stage: "shutdown-requested",
      observedAt: new Date(snapshot.observedAt).toISOString(),
    })
    assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(snapshotFile))).mode & 0o777, 0o700)
    assert.equal((await stat(markerFile)).mode & 0o777, 0o600)
  } finally {
    await fixture.close()
  }
})

for (const failure of [
  {
    condition: "shutdown throws",
    shutdown() {
      throw new Error("private shutdown details")
    },
  },
  {
    condition: "shutdown rejects asynchronously",
    shutdown() {
      return Promise.reject(new Error("private shutdown details"))
    },
  },
]) {
  test(`when ${failure.condition}, only sanitized rejection evidence remains`, async () => {
    // Arrange
    const fixture = await createRestartDirectoryFixture()
    const { ctx, handlers, launchDirectory, record, scope, transport } = fixture
    const request = createRequest(record.instanceId, "restart", "custom 🔒\nrequest")
    const operationId = createHash("sha256").update(request.requestId).digest("hex")
    const rejectionNotified = Promise.withResolvers()
    ctx.shutdown = failure.shutdown
    ctx.ui.notify = rejectionNotified.resolve

    try {
      // Act
      const accepted = await transport.request(record, request)
      const notification = await rejectionNotified.promise
      await handlers.get("session_shutdown")({}, ctx)

      // Assert
      assert.equal(accepted.data.operationId, request.requestId)
      assert.match(notification, /could not accept graceful shutdown/)
      const file = observationFile(scope, record.instanceId)
      const snapshot = JSON.parse(await readFile(file, "utf8"))
      assert.deepEqual(snapshot, {
        operationId,
        previousInstanceId: record.instanceId,
        stage: "shutdown-rejected",
        observedAt: new Date(snapshot.observedAt).toISOString(),
        error: "shutdown-rejected",
      })
      await assert.rejects(readFile(path.join(launchDirectory, "restart-observation.json")), {
        code: "ENOENT",
      })
      await assert.rejects(readFile(path.join(launchDirectory, "handoff.json")), {
        code: "ENOENT",
      })
    } finally {
      await fixture.close()
    }
  })
}

const replacementRestart = {
  operationId: "e".repeat(64),
  previousInstanceId: "f".repeat(32),
}

test("when a replacement serves its live record, its restart is observed online", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture({
    lastRestart: replacementRestart,
  })
  const { launchDirectory, record, scope, transport } = fixture
  const operationId = createHash("sha256").update(replacementRestart.operationId).digest("hex")
  const { previousInstanceId } = replacementRestart
  const expectedMarker = {
    operationId,
    previousInstanceId,
  }
  const markerFile = path.join(launchDirectory, "restart-online.json")
  const snapshotFile = observationFile(scope, previousInstanceId)

  try {
    // Act
    const status = await transport.request(record, createRequest(record.instanceId, "status"))

    // Assert
    const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"))
    assert.deepEqual(status.data.lastRestart, replacementRestart)
    assert.deepEqual(JSON.parse(await readFile(markerFile, "utf8")), expectedMarker)
    assert.deepEqual(snapshot, {
      ...expectedMarker,
      stage: "replacement-online",
      observedAt: new Date(snapshot.observedAt).toISOString(),
    })
  } finally {
    await fixture.close()
  }
})

test("when a replacement cannot refresh its initial record, it leaves no online observation", async () => {
  // Arrange
  const options = {
    lastRestart: replacementRestart,
    failRefresh: true,
  }

  // Act
  const fixture = await createRestartDirectoryFixture(options)
  const { launchDirectory, notifications, record, scope } = fixture

  try {
    // Assert
    assert.equal(record, undefined)
    assert.equal(
      notifications[0].message,
      "Instance control unavailable: Initial record unavailable"
    )
    await assert.rejects(readFile(path.join(launchDirectory, "restart-online.json")), {
      code: "ENOENT",
    })
    await assert.rejects(readFile(observationFile(scope, replacementRestart.previousInstanceId)), {
      code: "ENOENT",
    })
  } finally {
    await fixture.close()
  }
})

test("when OMP reloads in place, it does not replay an earlier restart", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture({
    lastRestart: replacementRestart,
  })
  const { ctx, handlers, launchDirectory, scope } = fixture

  try {
    await handlers.get("session_shutdown")({}, ctx)
    const onlineMarker = path.join(launchDirectory, "restart-online.json")
    const staleMarker = path.join(launchDirectory, "restart-observation.json")
    const readiness = JSON.parse(await readFile(onlineMarker, "utf8"))
    const newerObservation = {
      operationId: "4".repeat(64),
      previousInstanceId: `ff${"4".repeat(30)}`,
      stage: "replacement-starting",
      observedAt: new Date().toISOString(),
    }
    const file = observationFile(scope, replacementRestart.previousInstanceId)
    await writePrivateJson(staleMarker, readiness)
    await writePrivateJson(file, newerObservation)
    const extension = createExtensionApi(createEventBus(), handlers)

    // Act
    await instanceControl(extension.api)
    await handlers.get("session_start")({}, ctx)

    // Assert
    await assert.rejects(readFile(staleMarker), {
      code: "ENOENT",
    })
    assert.deepEqual(JSON.parse(await readFile(onlineMarker, "utf8")), readiness)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), newerObservation)
  } finally {
    await fixture.close()
  }
})

test("when diagnostic destinations are unsafe, shutdown and the validated handoff still proceed", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture()
  const { ctx, handlers, launchDirectory, record, scope, shutdownRequested, transport } = fixture
  const request = createRequest(record.instanceId, "restart")
  const snapshotFile = observationFile(scope, record.instanceId)
  const diagnosticDirectory = path.dirname(snapshotFile)
  const markerFile = path.join(launchDirectory, "restart-observation.json")
  const sentinel = path.join(launchDirectory, "sentinel")

  try {
    await mkdir(path.dirname(diagnosticDirectory), {
      recursive: true,
      mode: 0o700,
    })
    await writeFile(sentinel, "unchanged")
    await symlink(launchDirectory, diagnosticDirectory, "dir")
    await symlink(sentinel, markerFile)

    // Act
    const accepted = await transport.request(record, request)
    await shutdownRequested.promise
    await handlers.get("session_shutdown")({}, ctx)

    // Assert
    const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))
    assert.equal(accepted.data.operationId, request.requestId)
    assert.equal(handoff.operationId, request.requestId)
    assert.equal(await readFile(sentinel, "utf8"), "unchanged")
    assert.equal(await readFile(markerFile, "utf8"), "unchanged")
    await assert.rejects(readFile(path.join(launchDirectory, path.basename(snapshotFile))), {
      code: "ENOENT",
    })
  } finally {
    await fixture.close()
  }
})
