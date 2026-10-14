import { parseArgs } from "node:util"

import packageJson from "../package.json" with { type: "json" }
import { formatRows, listInstances, restartInstances } from "../cli/client.js"
import { waitForRestarts } from "../cli/restart-wait.js"
import { listProfileNames } from "../linux/profiles.js"
import { createTransport } from "../linux/transport.js"
import { getScope } from "../protocol/index.js"
import { prepareTakeover } from "./take-over.js"

const COMMAND = "ompi"
const PROGRESS_WIDGET = "ompi-restart-progress"
const RESTART_ONLY_OPTIONS = ["all", "instance", "no-wait"]
const ROOT_COMPLETIONS = ["instances", "take-over", "--help", "-h", "--version"]
const ACTION_COMPLETIONS = ["list", "restart", "--help", "-h", "--version"]
const LIST_COMPLETIONS = ["--profile", "--json", "--help", "-h", "--version"]
const RESTART_COMPLETIONS = [
  "--all",
  "--instance",
  "--profile",
  "--json",
  "--no-wait",
  "--help",
  "-h",
  "--version",
]
const COMPLETABLE_OPTIONS = new Set([
  "--all",
  "--instance",
  "--profile",
  "--json",
  "--no-wait",
  "--help",
  "-h",
  "--version",
])

function isMainTerminal(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui"
}

const BOOLEAN_OPTIONS = new Set(["all", "json", "no-wait", "help", "version"])
const TRUE_VALUES = new Set(["1", "t", "T", "TRUE", "true", "True"])
const FALSE_VALUES = new Set(["0", "f", "F", "FALSE", "false", "False"])

function normalizeBooleanArguments(args) {
  const normalizedArgs = []
  const assignedValues = new Map()
  let optionsEnabled = true
  const tokens = args.trim() ? args.trim().split(/\s+/) : []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (optionsEnabled && token === "--") {
      optionsEnabled = false
      normalizedArgs.push(token)
      continue
    }
    if (!optionsEnabled) {
      normalizedArgs.push(token)
      continue
    }
    if (token === "--instance" || token === "--profile") {
      normalizedArgs.push(token)
      if (tokens[index + 1] !== undefined) {
        normalizedArgs.push(tokens[index + 1])
        index += 1
      }
      continue
    }

    const match = token.match(/^--([a-z-]+)(?:=(.*))?$/)
    const shortHelp = token.match(/^-h(?:=(.*))?$/)
    const name = shortHelp ? "help" : match?.[1]
    if (!name || !BOOLEAN_OPTIONS.has(name)) {
      normalizedArgs.push(token)
      continue
    }

    const assigned = shortHelp ? shortHelp[1] : match[2]
    let value = true
    if (assigned !== undefined) {
      if (TRUE_VALUES.has(assigned)) {
        value = true
      } else if (FALSE_VALUES.has(assigned)) {
        value = false
      } else {
        throw new Error(`Invalid boolean value for --${name}: ${assigned}`)
      }
    }
    normalizedArgs.push(name === "help" && shortHelp ? "-h" : `--${name}`)
    assignedValues.set(name, value)
  }

  return { args: normalizedArgs, assignedValues }
}

function parseOmpiArguments(args) {
  const normalized = normalizeBooleanArguments(args)
  const parsed = parseArgs({
    args: normalized.args,
    options: {
      all: { type: "boolean" },
      instance: { type: "string" },
      profile: { type: "string" },
      json: { type: "boolean" },
      "no-wait": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
    allowPositionals: true,
    tokens: true,
  })
  for (const [name, value] of normalized.assignedValues) {
    parsed.values[name] = value
  }
  const present = new Set(
    parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name)
  )
  const positionals = [...parsed.positionals]

  if (parsed.values.help && parsed.values.version) {
    throw new Error("Choose either --help or --version.")
  }
  if (positionals.length === 0) {
    if (parsed.values.help) {
      return { action: "help", values: parsed.values, present }
    }
    if (parsed.values.version) {
      return { action: "version", values: parsed.values, present }
    }
    if (present.size === 0) {
      return { action: "help", values: parsed.values, present }
    }
    throw new Error(`Usage: /${COMMAND} instances list|restart [options]`)
  }

  const positionTokens = parsed.tokens.filter((token) => token.kind === "positional")
  const rootToken = positionTokens[0]
  if (positionals[0] === "take-over") {
    if (
      positionals.length !== 1 ||
      [...present].some((name) => !["help", "version"].includes(name))
    ) {
      throw new Error("Usage: /ompi take-over")
    }
    if (parsed.values.help) {
      return { action: "help", values: parsed.values, present }
    }
    if (parsed.values.version) {
      return { action: "version", values: parsed.values, present }
    }
    return { action: "take-over", values: parsed.values, present }
  }
  if (positionals.shift() !== "instances") {
    throw new Error(`Usage: /${COMMAND} instances list|restart [options]`)
  }
  if (
    parsed.tokens.some(
      (token) =>
        token.kind === "option" &&
        token.index < rootToken.index &&
        token.name !== "help" &&
        token.name !== "version"
    )
  ) {
    throw new Error(`Usage: /${COMMAND} instances list|restart [options]`)
  }

  const actionToken = positionTokens[1]
  if (
    actionToken &&
    parsed.tokens.some(
      (token) =>
        token.kind === "option" && token.index > rootToken.index && token.index < actionToken.index
    )
  ) {
    throw new Error(`Usage: /${COMMAND} instances list|restart [options]`)
  }
  const action = positionals.shift() ?? "list"
  if (positionals.length > 0 || !["list", "restart"].includes(action)) {
    throw new Error(`Usage: /${COMMAND} instances list|restart [options]`)
  }
  if (parsed.values.help) {
    return { action: "help", values: parsed.values, present }
  }
  if (parsed.values.version) {
    return { action: "version", values: parsed.values, present }
  }
  return { action, values: parsed.values, present }
}

function normalizeProfile(profile) {
  return profile === "" ? undefined : profile
}

function completionItem(value, label = value) {
  return { value, label }
}

function completionValues(items, completedTokens, tokenPrefix) {
  const argumentPrefix = completedTokens.length > 0 ? `${completedTokens.join(" ")} ` : ""
  return items
    .filter((item) => item.value.startsWith(tokenPrefix))
    .map((item) => completionItem(`${argumentPrefix}${item.value}`, item.label))
}

function selectedProfile(tokens) {
  let profile
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith("--profile=")) {
      profile = token.slice("--profile=".length)
    } else if (token === "--profile" && tokens[index + 1] && !tokens[index + 1].startsWith("-")) {
      profile = tokens[index + 1]
    }
  }
  return normalizeProfile(profile)
}

function scopeInstanceIds(completionIds, cwd, tokens) {
  try {
    const scope = getScope({ cwd, profile: selectedProfile(tokens) })
    return completionIds.get(scope.id) ?? new Set()
  } catch {
    return new Set()
  }
}

function getArgumentCompletions(argumentText, completionIds, profileNames, cwd) {
  const trailingSpace = /\s$/.test(argumentText)
  const tokens = argumentText.trim() ? argumentText.trim().split(/\s+/) : []
  let tokenPrefix = trailingSpace ? "" : (tokens.pop() ?? "")
  const completedTokens = trailingSpace ? tokens : [...tokens]
  const completedActionOrOption =
    tokenPrefix === "instances" ||
    ["list", "restart", "take-over"].includes(tokenPrefix) ||
    COMPLETABLE_OPTIONS.has(tokenPrefix)

  if (
    !trailingSpace &&
    completedActionOrOption &&
    (completedTokens.length === 0 || completedTokens[0] === "instances")
  ) {
    completedTokens.push(tokenPrefix)
    tokenPrefix = ""
  }

  if (completedTokens.length === 0) {
    return completionValues(
      ROOT_COMPLETIONS.map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }
  if (completedTokens[0] === "take-over") {
    return completionValues(
      ["--help", "-h", "--version"].map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }
  if (completedTokens[0] !== "instances") {
    return null
  }
  if (completedTokens.length === 1 && !tokenPrefix.startsWith("--profile=")) {
    const defaults = [
      ...ACTION_COMPLETIONS,
      ...LIST_COMPLETIONS.filter((option) => !ACTION_COMPLETIONS.includes(option)),
    ]
    return completionValues(
      defaults.map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }

  const explicitAction = ["list", "restart"].includes(completedTokens[1])
  const action = explicitAction ? completedTokens[1] : "list"
  const optionTokens = completedTokens.slice(explicitAction ? 2 : 1)
  if (!explicitAction) {
    for (let index = 0; index < optionTokens.length; index += 1) {
      const token = optionTokens[index]
      if (token === "--profile") {
        if (optionTokens[index + 1] && !optionTokens[index + 1].startsWith("-")) {
          index += 1
        }
        continue
      }
      if (token.startsWith("--profile=") || LIST_COMPLETIONS.includes(token)) {
        continue
      }
      return null
    }
  }
  const usedOptions = new Set(
    optionTokens
      .filter((token) => token.startsWith("--") || token === "-h")
      .map((token) => (token === "-h" ? "help" : token.slice(2).split("=")[0]))
  )
  if (action === "restart" && optionTokens.at(-1) === "--instance") {
    return completionValues(
      [...scopeInstanceIds(completionIds, cwd, completedTokens)].map((id) => completionItem(id)),
      completedTokens,
      tokenPrefix
    )
  }
  if (tokenPrefix.startsWith("--instance=")) {
    const idPrefix = tokenPrefix.slice("--instance=".length)
    const argumentPrefix = `${completedTokens.join(" ")} `
    return [...scopeInstanceIds(completionIds, cwd, completedTokens)]
      .filter((id) => id.startsWith(idPrefix))
      .map((id) => completionItem(`${argumentPrefix}--instance=${id}`))
  }
  if (optionTokens.at(-1) === "--profile") {
    return completionValues(
      profileNames.map((name) => completionItem(name)),
      completedTokens,
      tokenPrefix
    )
  }
  if (tokenPrefix.startsWith("--profile=")) {
    return completionValues(
      profileNames.map((name) => completionItem(`--profile=${name}`, name)),
      completedTokens,
      tokenPrefix
    )
  }

  let options = action === "list" ? LIST_COMPLETIONS : RESTART_COMPLETIONS
  if (action === "restart") {
    options = options.filter(
      (option) =>
        !(option === "--all" && usedOptions.has("instance")) &&
        !(option === "--instance" && usedOptions.has("all"))
    )
  }
  options = options.filter((option) => {
    const name = option === "-h" ? "help" : option.replace(/^--/, "")
    return !usedOptions.has(name)
  })
  return completionValues(
    options.map((value) => completionItem(value)),
    completedTokens,
    tokenPrefix
  )
}

function replaceCompletionIds(scope, rows, completionIds) {
  completionIds.set(
    scope.id,
    new Set(
      rows
        .filter((row) => row.status === "online")
        .map((row) => row.record?.instanceId)
        .filter(Boolean)
    )
  )
}

function rowsFromProgress(rows, watchedRows) {
  const watchedById = new Map(watchedRows.map((row) => [row.instanceId, row]))
  return rows.map((row) => watchedById.get(row.instanceId) ?? row)
}

function notifyRows(ctx, rows, json) {
  const hasFailure = rows.some((row) =>
    ["failed", "unknown", "unreachable", "restarting", "waiting"].includes(row.status)
  )
  ctx.ui.notify(json ? JSON.stringify(rows) : formatRows(rows), hasFailure ? "warning" : "info")
}

export function registerOmpiCommand(pi, { getRuntime = () => undefined } = {}) {
  const keybindings = pi.pi.KeybindingsManager.inMemory({ "app.clear": "ctrl+c" })
  const completionIds = new Map()
  let completionCwd
  let profileNames = ["default"]

  async function refreshProfileNames(scope) {
    try {
      profileNames = await listProfileNames(scope)
    } catch {
      profileNames = [...new Set(["default", scope.profile])]
    }
  }

  async function refreshCompletionIds(ctx, profile) {
    completionCwd = ctx.cwd
    let scope
    try {
      scope = getScope({ cwd: ctx.cwd, profile: normalizeProfile(profile) })
      await refreshProfileNames(scope)
      const transport = await createTransport(scope)
      const rows = await listInstances(transport)
      replaceCompletionIds(scope, rows, completionIds)
    } catch {
      if (scope) {
        completionIds.set(scope.id, new Set())
      }
    }
  }

  pi.registerCommand(COMMAND, {
    description: "Control participating instances or prepare a manual takeover",
    getArgumentCompletions(argumentText) {
      return getArgumentCompletions(argumentText, completionIds, profileNames, completionCwd)
    },
    async handler(args, ctx) {
      if (!isMainTerminal(ctx)) {
        ctx.ui.notify("Instance control requires a main OMP terminal.", "error")
        return
      }

      completionCwd = ctx.cwd
      try {
        const { action, values, present } = parseOmpiArguments(args)
        if (action === "help") {
          ctx.ui.notify(
            "Usage: /ompi instances [list|restart] [--all | --instance ID] [--profile NAME] [--json] [--no-wait]\nRestart requires exactly one explicit --all or --instance selector. Listing is the default action.\n/ompi take-over prepares a shell command for the current saved session and requests graceful exit. Copy it, then paste it in your shell after OMP exits.",
            "info"
          )
          return
        }
        if (action === "version") {
          ctx.ui.notify(`omp-instance-control ${packageJson.version}`, "info")
          return
        }
        if (action === "take-over") {
          if (getRuntime()) {
            throw new Error("This session already runs under ompi; use /ompi instances restart.")
          }
          const command = await prepareTakeover(ctx)
          const confirmed = await ctx.ui.confirm(
            "Take Over With ompi",
            `Copy this command now. After OMP exits, paste it in your shell:\n\n${command}\n\nExit gracefully? No replacement starts automatically.`
          )
          if (!confirmed) {
            return
          }

          if ((await prepareTakeover(ctx)) !== command) {
            throw new Error(
              "The session changed while the command was displayed; run /ompi take-over again."
            )
          }

          pi.appendEntry("ompi-take-over", { command })
          ctx.shutdown()
          return
        }

        if (action === "list" && RESTART_ONLY_OPTIONS.some((name) => present.has(name))) {
          throw new Error("--all, --instance, and --no-wait apply only to restart.")
        }

        if (action === "restart") {
          if (values.all === Boolean(values.instance)) {
            throw new Error("Choose exactly one of --all or --instance <id>.")
          }
        }

        const scope = getScope({ cwd: ctx.cwd, profile: normalizeProfile(values.profile) })
        const transport = await createTransport(scope)
        if (action === "list") {
          const rows = await listInstances(transport)
          replaceCompletionIds(scope, rows, completionIds)
          await refreshProfileNames(scope)
          notifyRows(ctx, rows, values.json === true)
          return
        }

        const rows = await restartInstances(transport, {
          all: values.all === true,
          instanceId: values.instance,
        })
        const runtime = getRuntime()
        const selfRow =
          runtime?.launch.scope.id === scope.id
            ? rows.find((row) => row.instanceId === runtime.instanceId)
            : undefined
        let finalRows = rows
        let observationMessage

        if (selfRow) {
          observationMessage =
            selfRow.status === "accepted"
              ? "This instance's restart is accepted and pending. The invoking terminal cannot wait for its own relaunch; OMP will resume the persisted session and cwd."
              : `This instance was selected, but its restart outcome is ${selfRow.status}; this terminal cannot observe its own relaunch.`
        } else if (values["no-wait"] !== true) {
          const acceptedRows = rows.filter((row) => row.status === "accepted")
          if (acceptedRows.length > 0) {
            const controller = new AbortController()
            let lastProgress = acceptedRows.map((row) => ({ ...row, status: "restarting" }))
            const stopListening = ctx.ui.onTerminalInput((data) => {
              if (keybindings.matches(data, "app.clear")) {
                controller.abort(new Error("Restart observation cancelled."))
                return { consume: true }
              }
              return undefined
            })
            try {
              const watchedRows = await waitForRestarts(transport, acceptedRows, {
                signal: controller.signal,
                onProgress(progressRows) {
                  lastProgress = progressRows.map((row) => ({ ...row }))
                  ctx.ui.setWidget(
                    PROGRESS_WIDGET,
                    [
                      "Waiting for peer restarts (Ctrl-C stops watching):",
                      ...formatRows(progressRows).split("\n"),
                    ],
                    { placement: "aboveEditor" }
                  )
                },
              })
              finalRows = rowsFromProgress(rows, watchedRows)
              if (watchedRows.some((row) => row.status === "restarted")) {
                await refreshCompletionIds(ctx, values.profile)
              }
            } catch (error) {
              finalRows = rowsFromProgress(rows, lastProgress)
              observationMessage = controller.signal.aborted
                ? "Restart observation cancelled; accepted restart requests remain active."
                : `Restart requests were accepted, but observation stopped: ${error.message}`
            } finally {
              stopListening()
              ctx.ui.setWidget(PROGRESS_WIDGET, undefined)
            }
          }
        }

        notifyRows(ctx, finalRows, values.json === true)
        if (observationMessage) {
          ctx.ui.notify(observationMessage, "warning")
        }
      } catch (error) {
        ctx.ui.notify(error.message, "error")
      }
    },
  })

  return refreshCompletionIds
}
