import assert from "node:assert/strict"
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import { createRequest } from "../../protocol/index.js"
import { createRestartDirectoryFixture } from "./restart-directory-fixture.js"

async function replaceInstalledWrapper(executable) {
  const replacement = `${executable}.new`
  await writeFile(replacement, "#!/bin/sh\nprintf 'ompi 0.19.0\\n'\n", {
    mode: 0o700,
  })
  await rename(replacement, executable)
}

async function materializeTranscript(sessionFile) {
  await writeFile(sessionFile, '{"type":"session","id":"cwd-session"}\n', {
    mode: 0o600,
  })
}

test("when the installed wrapper changes, ordinary restart hands off without a pin", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture({
    withInstalledWrapper: true,
    supportsInstalledWrapperSelection: true,
  })
  const {
    ctx,
    executable,
    handlers,
    launchDirectory,
    nativeTarget,
    record,
    sessionFile,
    transport,
  } = fixture
  const request = createRequest(record.instanceId, "restart-wrapper")
  try {
    await rm(sessionFile)

    // Act
    const first = await transport.request(record, request)
    assert.equal(first.data.operationId, request.requestId)

    await replaceInstalledWrapper(executable)
    const duplicate = await transport.request(record, {
      ...createRequest(record.instanceId, "restart-wrapper"),
      nativeTarget,
    })

    // Assert
    assert.equal(duplicate.data.operationId, request.requestId)
    assert.equal(fixture.shutdowns, 0)

    // Act
    await materializeTranscript(sessionFile)
    await handlers.get("agent_end")({}, ctx)
    await handlers.get("session_shutdown")({}, ctx)

    const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))

    // Assert
    assert.equal(fixture.shutdowns, 1)
    assert.equal(handoff.operationId, request.requestId)
    assert.equal(handoff.restartWrapper, true)
    assert.equal(Object.hasOwn(handoff, "nativeTarget"), false)
  } finally {
    await fixture.close()
  }
})

for (const scenario of [
  {
    name: "when the first request explicitly pins, an ordinary duplicate does not unpin it",
    advertisesSelection: true,
    explicitPin: true,
  },
  {
    name: "when capability is not boolean true, the handoff retains the admission pin",
    advertisesSelection: "true",
    explicitPin: false,
  },
]) {
  test(scenario.name, async () => {
    // Arrange
    const fixture = await createRestartDirectoryFixture({
      withInstalledWrapper: true,
      supportsInstalledWrapperSelection: scenario.advertisesSelection,
    })
    const { ctx, handlers, launchDirectory, nativeTarget, record, sessionFile, transport } = fixture
    const first = createRequest(record.instanceId, "restart-wrapper")
    if (scenario.explicitPin) first.nativeTarget = nativeTarget

    try {
      await rm(sessionFile)

      // Act
      const accepted = await transport.request(record, first)
      const duplicate = await transport.request(
        record,
        createRequest(record.instanceId, "restart-wrapper")
      )

      // Assert
      assert.equal(accepted.data.operationId, first.requestId)
      assert.equal(duplicate.data.operationId, first.requestId)
      assert.equal(fixture.shutdowns, 0)

      // Act
      await materializeTranscript(sessionFile)
      await handlers.get("agent_end")({}, ctx)
      await handlers.get("session_shutdown")({}, ctx)

      const handoff = JSON.parse(await readFile(path.join(launchDirectory, "handoff.json"), "utf8"))

      // Assert
      assert.equal(fixture.shutdowns, 1)
      assert.equal(handoff.operationId, first.requestId)
      assert.equal(handoff.restartWrapper, true)
      assert.deepEqual(handoff.nativeTarget, nativeTarget)
    } finally {
      await fixture.close()
    }
  })
}

test("when an explicit pin changes, restart refuses shutdown and permits retry", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture({
    withInstalledWrapper: true,
    supportsInstalledWrapperSelection: true,
  })
  const {
    ctx,
    executable,
    handlers,
    launchDirectory,
    nativeTarget,
    record,
    sessionFile,
    transport,
  } = fixture
  const first = {
    ...createRequest(record.instanceId, "restart-wrapper"),
    nativeTarget,
  }
  try {
    await rm(sessionFile)

    // Act
    const accepted = await transport.request(record, first)
    assert.equal(accepted.data.operationId, first.requestId)

    await replaceInstalledWrapper(executable)
    await materializeTranscript(sessionFile)
    await handlers.get("agent_end")({}, ctx)
    const refused = await transport.request(record, createRequest(record.instanceId, "status"))

    // Assert
    assert.equal(fixture.shutdowns, 0)
    assert.equal(refused.data.state, "running")
    assert.equal(refused.data.operationId, null)
    assert.equal(refused.data.refusedRestartOperationId, first.requestId)
    assert.ok(fixture.notifications.some(({ message }) => message.includes("no longer matches")))
    await assert.rejects(readFile(path.join(launchDirectory, "handoff.json")), {
      code: "ENOENT",
    })

    // Act
    const retry = createRequest(record.instanceId, "restart-wrapper")
    const acceptedRetry = await transport.request(record, retry)
    assert.equal(acceptedRetry.data.operationId, retry.requestId)
    await fixture.shutdownRequested.promise
    const pending = await transport.request(record, createRequest(record.instanceId, "status"))

    // Assert
    assert.equal(pending.data.operationId, retry.requestId)
    assert.equal(pending.data.refusedRestartOperationId, first.requestId)
    assert.equal(fixture.shutdowns, 1)
  } finally {
    await fixture.close()
  }
})

test("when the wrapper is unusable, admission or pre-shutdown refuses restart", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture({
    withInstalledWrapper: true,
    supportsInstalledWrapperSelection: true,
  })
  const { ctx, executable, handlers, record, sessionFile, transport } = fixture
  try {
    const moved = `${executable}.moved`
    await rename(executable, moved)

    // Act
    const rejected = await transport.request(
      record,
      createRequest(record.instanceId, "restart-wrapper")
    )

    // Assert
    assert.equal(rejected.error.code, "NATIVE_TARGET_UNAVAILABLE")
    assert.equal(fixture.shutdowns, 0)

    await rename(moved, executable)
    await rm(sessionFile)

    // Act
    const request = createRequest(record.instanceId, "restart-wrapper")
    const accepted = await transport.request(record, request)
    assert.equal(accepted.data.operationId, request.requestId)

    await chmod(executable, 0o600)
    await materializeTranscript(sessionFile)
    await handlers.get("agent_end")({}, ctx)
    const refused = await transport.request(record, createRequest(record.instanceId, "status"))

    // Assert
    assert.equal(fixture.shutdowns, 0)
    assert.equal(refused.data.refusedRestartOperationId, request.requestId)
    assert.ok(
      fixture.notifications.some(({ message }) => message.includes("could not be verified"))
    )

    // Act
    await chmod(executable, 0o700)
    const retry = createRequest(record.instanceId, "restart-wrapper")
    const acceptedRetry = await transport.request(record, retry)
    assert.equal(acceptedRetry.data.operationId, retry.requestId)
    await fixture.shutdownRequested.promise

    // Assert
    assert.equal(fixture.shutdowns, 1)
  } finally {
    await fixture.close()
  }
})

test("when another session is active, the pending wrapper restart waits", async () => {
  // Arrange
  const fixture = await createRestartDirectoryFixture({
    withInstalledWrapper: true,
    supportsInstalledWrapperSelection: true,
  })
  const { ctx, handlers, record, sessionFile, transport } = fixture
  const otherContext = {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getSessionId: () => "other-session",
    },
  }
  try {
    await rm(sessionFile)

    // Act
    const request = createRequest(record.instanceId, "restart-wrapper")
    const accepted = await transport.request(record, request)
    assert.equal(accepted.data.operationId, request.requestId)

    await handlers.get("session_switch")({}, otherContext)
    await materializeTranscript(sessionFile)
    await handlers.get("agent_end")({}, otherContext)
    const waiting = await transport.request(record, createRequest(record.instanceId, "status"))

    // Assert
    assert.equal(waiting.data.operationId, request.requestId)
    assert.equal(waiting.data.refusedRestartOperationId, undefined)
    assert.equal(fixture.shutdowns, 0)
    assert.ok(fixture.notifications.some(({ message }) => message.includes("original session")))

    // Act
    await handlers.get("session_switch")({}, ctx)

    // Assert
    assert.equal(fixture.shutdowns, 1)
  } finally {
    await fixture.close()
  }
})
