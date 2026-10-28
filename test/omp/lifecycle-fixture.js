import { appendFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { createTransport, writePrivateJson } from "../../linux/transport.js"
import { getScope } from "../../protocol/index.js"

import instanceControl from "../../omp/index.js"

export function createEventBus() {
  const listeners = new Map()
  return {
    emit(channel, value) {
      for (const listener of listeners.get(channel) ?? []) {
        listener(value)
      }
    },
    on(channel, listener) {
      let channelListeners = listeners.get(channel)
      if (!channelListeners) {
        channelListeners = new Set()
        listeners.set(channel, channelListeners)
      }
      channelListeners.add(listener)
      return () => channelListeners.delete(listener)
    },
  }
}

export function createSdk() {
  return {
    VERSION: "18.13.2",
    z: {
      object(properties) {
        return properties
      },
      string() {
        const schema = {}
        schema.optional = () => schema
        return schema
      },
      boolean() {
        return {}
      },
    },
    KeybindingsManager: {
      inMemory() {
        return { matches: () => false }
      },
    },
  }
}

export function createExtensionApi(
  events,
  handlers,
  ctx,
  { branch = [], deliverMessage, includeBranch = true, afterAppendEntry } = {}
) {
  const tools = new Map()
  const preparationRequested = Promise.withResolvers()
  const messages = []
  if (includeBranch) {
    ctx.sessionManager.getBranch = () => branch
  }

  return {
    api: {
      events,
      pi: createSdk(),
      runtime: { flagValues: new Map() },
      registerTool(tool) {
        tools.set(tool.name, tool)
      },
      appendEntry(customType, data) {
        const entry = { type: "custom", customType, data }
        branch.push(entry)
        appendFileSync(ctx.sessionManager.getSessionFile(), `${JSON.stringify(entry)}\n`)
        afterAppendEntry?.(entry)
      },
      sendUserMessage(content, options) {
        messages.push({ content, options })
        preparationRequested.resolve()
        return deliverMessage?.(content, options)
      },
      on(event, handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    },
    branch,
    messages,
    preparationRequested: preparationRequested.promise,
    tools,
  }
}

export async function waitForPreparation(extension) {
  await Promise.race([
    extension.preparationRequested,
    delay(2_000).then(() => {
      throw new Error("The cooperative preparation message was not delivered.")
    }),
  ])
}

export async function createResumeFixture({
  operationId = "restart-operation",
  previousInstanceId = "previous-instance",
  checkpoint = {},
  priorContinuations = [],
  deliverMessage,
  includeBranch = true,
  hostVersion = "18.13.2",
  lastRestart = { operationId, previousInstanceId },
  idleState,
  afterAppendEntry,
  events = createEventBus(),
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ic-resume-"))
  const launchDirectory = path.join(root, "launch")
  const sessionFile = path.join(root, "resumed-session.jsonl")
  const sessionId = "resumed-session"
  const token = "9".repeat(32)
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
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  )
  Object.assign(process.env, environment)
  const scope = getScope({ env: environment, cwd: root })
  await mkdir(launchDirectory, { mode: 0o700 })
  const savedCheckpoint = {
    entryId: "saved-checkpoint",
    kind: "checkpoint",
    operationId,
    previousInstanceId,
    instanceId: previousInstanceId,
    sessionId,
    sessionFile,
    cwd: root,
    scopeId: scope.id,
    requestedAt: 1_000,
    checkpointAt: 1_001,
    ready: true,
    checkpoint: "Completed: prepare the result. Remaining: finish the verification.",
    ...checkpoint,
  }
  const entries = [
    savedCheckpoint,
    ...priorContinuations.map((entry, index) => ({
      entryId: `prior-continuation-${index}`,
      kind: "continuation",
      operationId,
      previousInstanceId,
      sessionId,
      sessionFile,
      cwd: root,
      scopeId: scope.id,
      ...entry,
    })),
  ]
  const transcript = [
    { type: "session", id: sessionId },
    ...entries.map((data) => ({
      type: "custom",
      customType: "ompi-cooperative-restart",
      data,
    })),
  ]
  await writeFile(sessionFile, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    mode: 0o600,
  })
  await writePrivateJson(path.join(launchDirectory, "launch.json"), {
    version: 1,
    token,
    pid: process.ppid,
    scope,
    extensionPath: fileURLToPath(new URL("../../omp/index.js", import.meta.url)),
    lastRestart,
    builtinFlags: [],
  })

  let shutdowns = 0
  const shutdownRequested = Promise.withResolvers()
  const handlers = new Map()
  const sessionContext = {
    agent: { kind: "main" },
    mode: "tui",
    cwd: root,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
    ui: {
      setStatus() {},
      notify() {},
    },
    ...(idleState
      ? {
          isIdle: () => idleState().idle,
          hasPendingMessages: () => idleState().pending,
          getAsyncJobSnapshot: () => idleState().snapshot,
        }
      : {}),
    shutdown() {
      shutdowns += 1
      shutdownRequested.resolve()
    },
  }
  const extension = createExtensionApi(events, handlers, sessionContext, {
    branch: transcript.slice(1),
    deliverMessage,
    afterAppendEntry,
    includeBranch,
  })
  extension.api.pi.VERSION = hostVersion

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await handlers.get("session_shutdown")?.({}, sessionContext)
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  }

  try {
    await instanceControl(extension.api)
    await handlers.get("session_start")({}, sessionContext)
    const transport = await createTransport(scope)
    const [record] = await transport.readRecords()
    return {
      close,
      ctx: sessionContext,
      extension,
      handlers,
      record,
      events,
      transport,
      shutdownRequested: shutdownRequested.promise,
      get shutdowns() {
        return shutdowns
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
