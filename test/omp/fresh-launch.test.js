import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, readFile, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { registerFreshLaunch } from "../../omp/fresh-launch.js"
import { createEventBus } from "./lifecycle-fixture.js"

async function managedSession(t, shutdown) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-fresh-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, "project ; $(not a command)")
  await mkdir(directory)

  const launch = {
    directory: root,
    handoffPath: path.join(root, "handoff.json"),
    pid: process.ppid,
    token: "1".repeat(32),
    scope: {
      id: "2".repeat(16),
    },
  }
  const ctx = {
    agent: {
      kind: "main",
    },
    mode: "tui",
    sessionManager: {
      getSessionId: () => "active-session",
    },
    shutdown: t.mock.fn(shutdown),
  }
  const state = {
    launch,
    instanceId: "3".repeat(32),
    ctx,
    server: true,
  }
  const events = createEventBus()
  const processEvents = new EventEmitter()
  const fresh = registerFreshLaunch({ events }, launch, () => state, { processEvents })
  t.after(fresh.release)

  function send(operation, data) {
    const envelope = {
      sessionId: "active-session",
      ...data,
    }
    events.emit(`omp-instance-control:fresh-launch:${operation}`, envelope)
    return envelope.result
  }

  return { ctx, directory, fresh, launch, processEvents, send, state }
}

function prepareTicket(send, directory) {
  const preparation = send("prepare", { directory })
  assert.equal(preparation.status, "accepted", preparation.message)
  return preparation.ticket
}

function commitPreparedLaunch(send, directory) {
  const ticket = prepareTicket(send, directory)
  const commit = send("commit", { ticket })
  assert.equal(commit.status, "committed", commit.message)
  return ticket
}

test("fresh launch refuses a request from another session", async (t) => {
  // Arrange
  const { ctx, directory, send } = await managedSession(t)

  // Act
  const result = send("prepare", {
    sessionId: "other-session",
    directory,
  })

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("fresh launch refuses a request after the owning launch changes", async (t) => {
  // Arrange
  const { ctx, directory, launch, send, state } = await managedSession(t)
  state.launch = {
    ...launch,
    token: "9".repeat(32),
  }

  // Act
  const result = send("prepare", { directory })

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("fresh launch refuses a relative destination", async (t) => {
  // Arrange
  const { ctx, send } = await managedSession(t)

  // Act
  const result = send("prepare", { directory: "relative" })

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("fresh launch refuses a destination that does not exist", async (t) => {
  // Arrange
  const { ctx, directory, send } = await managedSession(t)
  const missingDirectory = path.join(directory, "missing")

  // Act
  const result = send("prepare", { directory: missingDirectory })

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("fresh launch refuses an unresolved symlink destination", async (t) => {
  // Arrange
  const { ctx, directory, launch, send } = await managedSession(t)
  const symlinkedDirectory = path.join(launch.directory, "unresolved")
  await symlink(directory, symlinkedDirectory)

  // Act
  const result = send("prepare", { directory: symlinkedDirectory })

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("fresh launch refuses a commit with the wrong ticket", async (t) => {
  // Arrange
  const { ctx, directory, send } = await managedSession(t)
  prepareTicket(send, directory)

  // Act
  const result = send("commit", { ticket: "wrong-ticket" })

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("cancelling a prepared fresh launch prevents its ticket from requesting shutdown", async (t) => {
  // Arrange
  const { ctx, directory, send } = await managedSession(t)
  const ticket = prepareTicket(send, directory)

  // Act
  const cancellation = send("cancel", { ticket })
  const retry = send("commit", { ticket })

  // Assert
  assert.equal(cancellation.status, "cancelled")
  assert.equal(retry.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("an unrelated clean exit does not publish a prepared fresh launch", async (t) => {
  // Arrange
  const { ctx, directory, fresh, launch, processEvents, send, state } = await managedSession(t)
  const preparation = send("prepare", { directory })

  // Act
  fresh.onShutdown(state, ctx)
  processEvents.emit("exit", 0)

  // Assert
  assert.equal(preparation.status, "accepted")
  await assert.rejects(readFile(launch.handoffPath), { code: "ENOENT" })
})

test("a confirmed fresh launch requests shutdown only once", async (t) => {
  // Arrange
  const { ctx, directory, send } = await managedSession(t)
  const ticket = prepareTicket(send, directory)

  // Act
  const commit = send("commit", { ticket })
  const duplicate = send("commit", { ticket })

  // Assert
  assert.equal(commit.status, "committed")
  assert.equal(duplicate.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 1)
})

test("a correlated clean exit publishes the approved directory without a resume source", async (t) => {
  // Arrange
  const { ctx, directory, fresh, launch, processEvents, send, state } = await managedSession(t)
  const ticket = commitPreparedLaunch(send, directory)
  fresh.onShutdown(state, ctx)

  // Act
  processEvents.emit("exit", 0)
  const handoff = JSON.parse(await readFile(launch.handoffPath, "utf8"))

  // Assert
  assert.equal(handoff.operationId, ticket)
  assert.equal(handoff.freshLaunch.directory, directory)
  assert.equal(handoff.sessionFile, undefined)
})

test("fresh launch is not published when teardown has not reached process exit", async (t) => {
  // Arrange
  const { ctx, directory, fresh, launch, send, state } = await managedSession(t)
  commitPreparedLaunch(send, directory)

  // Act
  fresh.onShutdown(state, ctx)

  // Assert
  await assert.rejects(readFile(launch.handoffPath), { code: "ENOENT" })
})

test("fresh launch is not published when the process exits without host teardown", async (t) => {
  // Arrange
  const { directory, launch, processEvents, send } = await managedSession(t)
  commitPreparedLaunch(send, directory)

  // Act
  processEvents.emit("exit", 0)

  // Assert
  await assert.rejects(readFile(launch.handoffPath), { code: "ENOENT" })
})

test("fresh launch is not published when host teardown belongs to another session", async (t) => {
  // Arrange
  const { ctx, directory, fresh, launch, processEvents, send, state } = await managedSession(t)
  commitPreparedLaunch(send, directory)
  ctx.sessionManager.getSessionId = () => "other-session"

  // Act
  fresh.onShutdown(state, ctx)
  processEvents.emit("exit", 0)

  // Assert
  await assert.rejects(readFile(launch.handoffPath), { code: "ENOENT" })
})

test("fresh launch is not published when the host exits unsuccessfully", async (t) => {
  // Arrange
  const { ctx, directory, fresh, launch, processEvents, send, state } = await managedSession(t)
  commitPreparedLaunch(send, directory)
  fresh.onShutdown(state, ctx)

  // Act
  processEvents.emit("exit", 1)

  // Assert
  await assert.rejects(readFile(launch.handoffPath), { code: "ENOENT" })
})

test("fresh launch is not published when the event loop drains instead of explicitly exiting", async (t) => {
  // Arrange
  const { ctx, directory, fresh, launch, processEvents, send, state } = await managedSession(t)
  commitPreparedLaunch(send, directory)
  fresh.onShutdown(state, ctx)

  // Act
  processEvents.emit("beforeExit", 0)
  processEvents.emit("exit", 0)

  // Assert
  await assert.rejects(readFile(launch.handoffPath), { code: "ENOENT" })
})

test("fresh launch refuses commit when the approved directory has been replaced", async (t) => {
  // Arrange
  const { ctx, directory, launch, send } = await managedSession(t)
  const ticket = prepareTicket(send, directory)
  await rename(directory, path.join(launch.directory, "moved"))
  await mkdir(directory)

  // Act
  const result = send("commit", { ticket })

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(ctx.shutdown.mock.callCount(), 0)
})

test("fresh launch refuses a commit if OMP rejects the shutdown request", async (t) => {
  // Arrange
  const { ctx, directory, fresh, launch, processEvents, send, state } = await managedSession(
    t,
    () => {
      throw new Error("shutdown unavailable")
    }
  )
  const ticket = prepareTicket(send, directory)

  // Act
  const result = send("commit", { ticket })
  fresh.onShutdown(state, ctx)
  processEvents.emit("exit", 0)

  // Assert
  assert.equal(result.status, "refused")
  assert.equal(result.message, "shutdown unavailable")
  await assert.rejects(readFile(launch.handoffPath), { code: "ENOENT" })
})
