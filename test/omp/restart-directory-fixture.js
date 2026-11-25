import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import instanceControl from "../../omp/index.js"
import { getScope } from "../../protocol/index.js"
import { createEventBus, createExtensionApi } from "./lifecycle-fixture.js"

export async function createRestartDirectoryFixture({
  sendMessages = [],
  lastRestart = null,
  failRefresh = false,
  withInstalledWrapper = false,
  supportsInstalledWrapperSelection,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-cwd-"))
  const cwd = path.join(root, "project")
  const moved = path.join(root, "moved")
  const launchDirectory = path.join(root, "launch")
  await mkdir(cwd, { mode: 0o700 })
  await mkdir(launchDirectory, { mode: 0o700 })
  const scope = getScope({ env: { HOME: root } })
  const token = "5".repeat(32)
  const sessionFile = path.join(root, "session.jsonl")
  await writeFile(sessionFile, '{"type":"session","id":"cwd-session"}\n', { mode: 0o600 })
  const executable = path.join(root, "ompi")
  let native
  let nativeTarget
  if (withInstalledWrapper) {
    await writeFile(executable, "#!/bin/sh\nprintf 'ompi 0.18.0\\n'\n", {
      mode: 0o700,
    })
    const image = await stat(executable, {
      bigint: true,
    })
    nativeTarget = {
      device: image.dev.toString(),
      inode: image.ino.toString(),
      size: image.size.toString(),
      modifiedNs: image.mtimeNs.toString(),
    }
    native = {
      executable,
      version: "0.18.0",
      device: nativeTarget.device,
      inode: nativeTarget.inode,
    }
  }

  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    canRestartWrapper: true,
    supportsInstalledWrapperSelection,
    native,
    lastRestart,
    builtinFlags: [],
  })
  const environment = {
    HOME: root,
    PI_CONFIG_DIR: path.join(root, ".omp"),
    PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent"),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    XDG_RUNTIME_DIR: root,
    OMP_INSTANCE_CONTROL_LAUNCH_DIR: launchDirectory,
    OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: token,
  }
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, environment)
  const handlers = new Map()
  const notifications = []
  const shutdownRequested = Promise.withResolvers()
  let shutdowns = 0
  let sessionIdReads = 0
  const ctx = {
    agent: { kind: "main" },
    mode: "tui",
    cwd,
    sessionManager: {
      getSessionId() {
        sessionIdReads += 1
        if (failRefresh && sessionIdReads === 2) {
          throw new Error("Initial record unavailable")
        }
        return "cwd-session"
      },
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus() {},
      notify(message, level) {
        notifications.push({ message, level })
      },
    },
    shutdown() {
      shutdowns += 1
      shutdownRequested.resolve()
    },
  }
  const extension = createExtensionApi(createEventBus(), handlers)
  extension.api.sendMessage = (content, options) => sendMessages.push({ content, options })
  await instanceControl(extension.api)
  await handlers.get("session_start")({}, ctx)
  const transport = await createTransport(scope)
  const [record] = await transport.readRecords()
  return {
    launchDirectory,
    scope,
    cwd,
    moved,
    sessionFile,
    executable,
    nativeTarget,
    handlers,
    ctx,
    api: extension.api,
    transport,
    record,
    notifications,
    shutdownRequested,
    get shutdowns() {
      return shutdowns
    },
    async close() {
      await handlers.get("session_shutdown")({}, ctx)
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

export function observationFile(scope, previousInstanceId) {
  return path.join(
    scope.agentDir,
    "instance-control",
    "restart-diagnostics-v1",
    `${previousInstanceId.slice(0, 2)}.json`
  )
}
