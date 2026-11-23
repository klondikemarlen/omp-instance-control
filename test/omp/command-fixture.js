import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createTransport } from "../../linux/transport.js"
import { registerOmpiCommand } from "../../omp/command.js"

export { createCommand, createContext, createFixture, createSdk }

const ENVIRONMENT_KEYS = [
  "HOME",
  "OMPI_USAGE",
  "PATH",
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_RUNTIME_DIR",
]

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "oc-"))
  const configRoot = path.join(root, "config")
  const cwd = path.join(root, "worktree")
  const runtimeRoot = path.join(root, "runtime")
  const privateDirectory = {
    mode: 0o700,
  }
  await Promise.all([
    mkdir(configRoot, privateDirectory),
    mkdir(cwd),
    mkdir(runtimeRoot, privateDirectory),
  ])
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    HOME: root,
    OMPI_USAGE: "0",
    PI_CONFIG_DIR: configRoot,
    PI_CODING_AGENT_DIR: path.join(configRoot, "agent"),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    XDG_RUNTIME_DIR: runtimeRoot,
  })
  const servers = []

  return {
    root,
    cwd,
    async addPeer(scope, instanceId, peerCwd = cwd, { sendContext, sessionTitle } = {}) {
      const transport = await createTransport(scope)
      const record = {
        version: 1,
        instanceId,
        scope: scope.id,
        pid: process.pid,
        cwd: peerCwd,
        sessionId: `session-${instanceId.slice(0, 8)}`,
        sessionFile: null,
        launcherManaged: true,
        state: "running",
        operationId: null,
        lastRestart: null,
      }
      await transport.writeRecord(record)
      const requests = []
      const server = await transport.serve(instanceId, async (request) => {
        requests.push(request)
        if (request.action === "status") {
          const data = { ...record, canRestart: true }
          if (sendContext !== undefined) {
            data.sendContext = sendContext
          }
          if (sessionTitle !== undefined) {
            data.sessionTitle = sessionTitle
          }
          return { data }
        }
        if (request.action === "send") {
          return {
            data: {
              state: "submitted",
              messageId: request.requestId,
              delivery: request.message.delivery,
            },
          }
        }
        return {
          data: {
            state: "accepted",
            operationId: request.requestId,
            message: "Restart accepted.",
          },
        }
      })
      servers.push({ server, transport, instanceId })
      return { record, requests }
    },
    async close() {
      await Promise.all(servers.map(({ server }) => server.close()))
      await Promise.all(
        servers.map(({ transport, instanceId }) => transport.removeRecord(instanceId))
      )
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

function createCommand(ctx, { runtime, cancelOnProgress = false, confirmTakeover } = {}) {
  const commands = new Map()
  const notifications = []
  const entries = []
  let terminalInput
  let cancelled = false
  const pi = {
    pi: createSdk(),
    appendEntry(customType, data) {
      entries.push({ customType, data })
    },
    registerCommand(name, command) {
      commands.set(name, command)
    },
  }
  const refreshCompletions = registerOmpiCommand(pi, {
    getRuntime: () => runtime,
  })
  ctx.ui = {
    theme: {
      fg(_color, text) {
        return text
      },
    },
    confirm: confirmTakeover,
    notify(message, level) {
      notifications.push({ message, level })
    },
    onTerminalInput(handler) {
      terminalInput = handler
      return () => {
        terminalInput = undefined
      }
    },
    setWidget(_key, content) {
      if (cancelOnProgress && content && !cancelled) {
        cancelled = true
        terminalInput("\u0003")
      }
    },
  }
  return {
    command: commands.get("ompi"),
    notifications,
    refreshCompletions,
  }
}

function createContext(cwd) {
  return { agent: { kind: "main" }, mode: "tui", cwd, ui: undefined }
}

function createSdk() {
  return {
    KeybindingsManager: {
      inMemory(bindings) {
        return {
          matches(data, action) {
            return (
              action === "app.clear" &&
              bindings[action] === "ctrl+c" &&
              ["\u0003", "\u001b[99;5u"].includes(data)
            )
          },
        }
      },
    },
  }
}
