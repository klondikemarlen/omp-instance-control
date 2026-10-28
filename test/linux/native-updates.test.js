import assert from "node:assert/strict"
import { watch } from "node:fs"
import { chmod, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import watchNativeUpdates from "../../linux/native-updates.js"

async function createExecutable(t, contents) {
  const directory = await mkdtemp(path.join(tmpdir(), "ompi-native-update-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const executable = path.join(directory, "ompi")
  await writeExecutable(executable, contents)
  return { directory, executable }
}

async function writeExecutable(file, contents) {
  await writeFile(file, `#!/bin/sh\n${contents}\n`)
  await chmod(file, 0o755)
}

async function nativeMetadata(executable, version = "1.0.0") {
  const image = await stat(executable, { bigint: true })
  return {
    executable,
    version,
    device: image.dev.toString(),
    inode: image.ino.toString(),
  }
}

async function replaceExecutable(executable, contents) {
  const replacement = `${executable}.new`
  await writeExecutable(replacement, contents)
  await rename(replacement, executable)
}

function observeProbeStart(t, directory) {
  const started = Promise.withResolvers()
  const observer = watch(directory, (_event, filename) => {
    if (filename === "probe.started") started.resolve()
  })
  t.after(() => observer.close())
  return started.promise
}

test("when the installed image is still running, its status is current without notification", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) => {
    notifications.push(notification.installedVersion)
  })
  t.after(() => watcher.close())

  // Act
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, [])
  assert.deepEqual(watcher.getStatus(), {
    runningVersion: "1.0.0",
    installedVersion: "1.0.0",
    state: "current",
  })
})

test("when a replacement has the same version but a different identity, it is available", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  await replaceExecutable(fixture.executable, "printf 'ompi 1.0.0\\n'")
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) => {
    notifications.push(notification.installedVersion)
  })
  t.after(() => watcher.close())

  // Act
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["1.0.0"])
  assert.deepEqual(watcher.getStatus(), {
    runningVersion: "1.0.0",
    installedVersion: "1.0.0",
    state: "available",
  })
})

test("when the installed executable is replaced atomically, one notification makes its version available", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  const notifications = []

  const watcher = watchNativeUpdates(native, async (notification) => {
    notifications.push(notification.installedVersion)
  })
  t.after(() => watcher.close())
  await watcher.refresh()

  // Act
  await replaceExecutable(fixture.executable, "printf 'ompi 2.0.0\\n'")
  await watcher.refresh()
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["2.0.0"])
  assert.deepEqual(watcher.getStatus(), {
    runningVersion: "1.0.0",
    installedVersion: "2.0.0",
    state: "available",
  })
})

test("when an available candidate is revisited after restoring the running image, its cached outcome is restored", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  const predecessor = `${fixture.executable}.running`
  const candidate = `${fixture.executable}.candidate`
  await rename(fixture.executable, predecessor)
  await writeExecutable(candidate, "printf 'ompi 2.0.0\\n'")
  await rename(candidate, fixture.executable)
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) =>
    notifications.push(notification.installedVersion)
  )
  t.after(() => watcher.close())

  // Act
  await watcher.refresh()
  const adoptedCandidate = `${fixture.executable}.adopted`
  await rename(fixture.executable, adoptedCandidate)
  await rename(predecessor, fixture.executable)
  await watcher.refresh()
  await rename(fixture.executable, predecessor)
  await rename(adoptedCandidate, fixture.executable)
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["2.0.0"])
  assert.deepEqual(watcher.getStatus(), {
    runningVersion: "1.0.0",
    installedVersion: "2.0.0",
    state: "available",
  })
})

test("when an available candidate temporarily disappears and returns, its cached outcome is restored", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  const predecessor = `${fixture.executable}.running`
  const missingCandidate = `${fixture.executable}.missing`
  await rename(fixture.executable, predecessor)
  await writeExecutable(fixture.executable, "printf 'ompi 2.0.0\\n'")
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) =>
    notifications.push(notification.installedVersion)
  )
  t.after(() => watcher.close())

  // Act
  await watcher.refresh()
  await rename(fixture.executable, missingCandidate)
  await watcher.refresh()
  await rename(missingCandidate, fixture.executable)
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["2.0.0"])
  assert.deepEqual(watcher.getStatus(), {
    runningVersion: "1.0.0",
    installedVersion: "2.0.0",
    state: "available",
  })
})

test("when a candidate changes in place, its changed fingerprint is probed and notified again", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  const predecessor = `${fixture.executable}.running`
  await rename(fixture.executable, predecessor)
  await writeExecutable(fixture.executable, "printf 'ompi 2.0.0\\n'")
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) => {
    notifications.push(notification.installedVersion)
  })
  t.after(() => watcher.close())

  // Act
  await watcher.refresh()
  await writeExecutable(fixture.executable, "printf 'ompi 3.0.0-dev\\n'")
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["2.0.0", "3.0.0-dev"])
})

test("when refreshes overlap an available update, the candidate receives only one notification", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  await replaceExecutable(fixture.executable, "printf 'ompi 2.0.0\\n'")
  const entered = Promise.withResolvers()
  const accepted = Promise.withResolvers()
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) => {
    notifications.push(notification.installedVersion)
    entered.resolve()
    await accepted.promise
  })
  t.after(() => watcher.close())

  // Act
  const refreshes = [watcher.refresh(), watcher.refresh(), watcher.refresh()]
  await entered.promise
  accepted.resolve()
  await Promise.all(refreshes)
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["2.0.0"])
  assert.equal(watcher.getStatus().state, "available")
})

test("when a changed executable has no native version marker, it is not notified", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  await replaceExecutable(fixture.executable, "printf 'omp/18.13.0\\n'")
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) =>
    notifications.push(notification)
  )
  t.after(() => watcher.close())

  // Act
  await watcher.refresh()
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, [])
  assert.equal(watcher.getStatus().state, "failed")
  assert.equal(watcher.getStatus().installedVersion, null)
  assert.equal(watcher.getStatus().runningVersion, "1.0.0")
})

test("when update notification fails, the same candidate is not notified repeatedly", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  await replaceExecutable(fixture.executable, "printf 'ompi 2.0.0\\n'")
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) => {
    notifications.push(notification.installedVersion)
    throw new Error("The status message could not be displayed.")
  })
  t.after(() => watcher.close())

  // Act
  await watcher.refresh()
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["2.0.0"])
  assert.equal(watcher.getStatus().state, "failed")
  assert.equal(watcher.getStatus().installedVersion, "2.0.0")
  assert.equal(watcher.getStatus().runningVersion, "1.0.0")
  assert.equal(
    watcher.getStatus().message,
    "Update notification failed: The status message could not be displayed."
  )
})

test("when installation changes during a probe, notification selects only the verified later candidate", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  const started = observeProbeStart(t, fixture.directory)
  const release = path.join(fixture.directory, "probe.release")
  await replaceExecutable(
    fixture.executable,
    `touch '${fixture.directory}/probe.started'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nprintf 'ompi 2.0.0\\n'`
  )
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) =>
    notifications.push(notification.installedVersion)
  )
  t.after(() => watcher.close())

  // Act
  const checking = watcher.refresh()
  await started
  await replaceExecutable(fixture.executable, "printf 'ompi 3.0.0\\n'")
  await writeFile(release, "")
  await checking
  await watcher.refresh()

  // Assert
  assert.deepEqual(notifications, ["3.0.0"])
  assert.equal(watcher.getStatus().installedVersion, "3.0.0")
})

test("when monitoring closes during a probe, no late notification is sent", async (t) => {
  // Arrange
  const fixture = await createExecutable(t, "printf 'ompi 1.0.0\\n'")
  const native = await nativeMetadata(fixture.executable)
  const started = observeProbeStart(t, fixture.directory)
  const release = path.join(fixture.directory, "probe.release")
  await replaceExecutable(
    fixture.executable,
    `touch '${fixture.directory}/probe.started'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nprintf 'ompi 2.0.0\\n'`
  )
  const notifications = []
  const watcher = watchNativeUpdates(native, async (notification) =>
    notifications.push(notification.installedVersion)
  )
  t.after(() => watcher.close())

  // Act
  const checking = watcher.refresh()
  await started
  watcher.close()
  await writeFile(release, "")
  await checking

  // Assert
  assert.deepEqual(notifications, [])
})
