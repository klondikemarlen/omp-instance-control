import { parseArgs } from "node:util"

import packageJson from "../package.json" with { type: "json" }
import { getScope } from "../protocol/index.js"
import { createTransport } from "../linux/transport.js"
import { listInstances, formatRows, restartInstances } from "../cli/client.js"
import { waitForRestarts } from "../cli/restart-wait.js"
import { listProfileNames } from "../linux/profiles.js"
import { listSavedSessions, validateRestoreName } from "../linux/restore.js"
import { prepareTakeover } from "./take-over.js"
import { listRecoveryCheckpoints, listRecoverySlotIds } from "../linux/recovery.js"
import { createRestoreCommand, getRestoreScope } from "./recovery-command.js"

const COMMAND = "ompi"
const PROGRESS_WIDGET = "ompi-restart-progress"
const RESTART_ONLY_OPTIONS = ["all", "instance", "no-wait"]
const ROOT_COMPLETIONS = ["instances", "restore", "take-over", "--help", "-h", "--version"]
const ACTION_COMPLETIONS = ["list", "restart", "cleanup", "--help", "-h", "--version"]
const LIST_COMPLETIONS = ["--profile", "--json", "--help", "-h", "--version"]
const CLEANUP_COMPLETIONS = ["--profile", "--json", "--help", "-h", "--version"]
const RESTORE_COMPLETIONS = [
  "save",
  "--list",
  "--checkpoint",
  "--history",
  "--from",
  "--slot",
  "--export",
  "--import-legacy",
  "--profile",
  "--help",
  "-h",
  "--version",
]
const RESTORE_LIST_COMPLETIONS = ["--json", "--from", "--profile", "--help", "-h", "--version"]
const RESTORE_SAVE_COMPLETIONS = ["--instance", "--profile", "--help", "-h", "--version"]
const RESTORE_HISTORY_COMPLETIONS = ["--json", "--profile", "--help", "-h", "--version"]

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
  "--list",
  "--profile",
  "--json",
  "--no-wait",
  "--help",
  "-h",
  "--version",
  "--checkpoint",
  "--history",
  "--from",
  "--slot",
  "--export",
  "--import-legacy",
])

function isMainTerminal(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui"
}

const BOOLEAN_OPTIONS = new Set([
  "all",
  "list",
  "json",
  "no-wait",
  "checkpoint",
  "history",
  "export",
  "help",
  "version",
])
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
    if (["--instance", "--profile", "--from", "--slot", "--import-legacy"].includes(token)) {
      normalizedArgs.push(token)
      if (tokens[index + 1] !== undefined && !tokens[index + 1].startsWith("--")) {
        normalizedArgs.push(tokens[index + 1])
        index += 1
      } else if (token === "--import-legacy") normalizedArgs.push("")
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
      slot: { type: "string" },
      from: { type: "string" },
      "import-legacy": { type: "string" },
      list: { type: "boolean" },
      checkpoint: { type: "boolean" },
      history: { type: "boolean" },
      export: { type: "boolean" },
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
    throw new Error(`Usage: /${COMMAND} instances list|restart|cleanup [options]`)
  }

  const positionTokens = parsed.tokens.filter((token) => token.kind === "positional")
  const rootToken = positionTokens[0]
  if (positionals[0] === "restore") {
    if (
      parsed.tokens.some(
        (token) =>
          token.kind === "option" &&
          token.index < rootToken.index &&
          token.name !== "help" &&
          token.name !== "version"
      )
    ) {
      throw new Error("Usage: /ompi restore [NAME|save NAME|--list] [options]")
    }
    if (parsed.values.help) {
      return { action: "help", values: parsed.values, present }
    }
    if (parsed.values.version) {
      return { action: "version", values: parsed.values, present }
    }

    const restoreArguments = positionals.slice(1)
    const recoveryFlags = ["checkpoint", "history", "export", "import-legacy", "slot"]
    const selectedRecoveryFlags = recoveryFlags.filter((flag) => present.has(flag))
    if (selectedRecoveryFlags.length > 1) throw new Error("Choose exactly one recovery operation.")
    if (present.has("from") && !selectedRecoveryFlags.length && !present.has("list")) {
      if (!/^[a-f0-9]{32}$/.test(parsed.values.from ?? ""))
        throw new Error("--from requires a full 32-character checkpoint ID.")
      if (
        restoreArguments.length ||
        [...present].some((flag) => !["from", "profile", "help", "version"].includes(flag))
      ) {
        throw new Error(
          "--from selection cannot be combined with a saved name or another recovery operation."
        )
      }
      return { action: "restore", operation: "recovery-from", values: parsed.values, present }
    }
    if (selectedRecoveryFlags.length) {
      const operation = selectedRecoveryFlags[0]
      const allowed = new Set(["profile", "from", "json", "help", "version", operation])
      if (
        [...present].some((flag) => !allowed.has(flag)) ||
        restoreArguments.length ||
        parsed.values.instance !== undefined
      ) {
        throw new Error(`Invalid options for /ompi restore --${operation}.`)
      }
      if (present.has("json") && operation !== "history") {
        throw new Error("--json applies only to recovery history or list.")
      }
      if (present.has("from") && operation !== "export") {
        throw new Error("--from applies only to recovery selection, list, or export.")
      }
      if (operation === "slot" && !/^[a-f0-9]{32}$/.test(parsed.values.slot ?? ""))
        throw new Error("--slot requires a full 32-character restore ID.")
      if (operation === "from" && !/^[a-f0-9]{32}$/.test(parsed.values.from ?? ""))
        throw new Error("--from requires a full 32-character checkpoint ID.")
      return {
        action: "restore",
        operation: `recovery-${operation}`,
        values: parsed.values,
        present,
      }
    }
    if ((present.has("from") || present.has("json")) && !present.has("list"))
      throw new Error("--from and --json require --list, --history, or --export.")
    if (restoreArguments[0] === "save") {
      if (
        restoreArguments.length !== 2 ||
        [...present].some((name) => !["instance", "profile", "help", "version"].includes(name))
      ) {
        throw new Error("Usage: /ompi restore save NAME [--instance FULL_ID] [--profile NAME]")
      }
      validateRestoreName(restoreArguments[1])
      if (present.has("instance") && !/^[a-f0-9]{32}$/.test(parsed.values.instance ?? "")) {
        throw new Error("--instance must be a full 32-character lowercase instance ID.")
      }
      return {
        action: "restore",
        operation: "save",
        name: restoreArguments[1],
        values: parsed.values,
        present,
      }
    }

    if (present.has("list") && present.has("from")) {
      if (!/^[a-f0-9]{32}$/.test(parsed.values.from ?? ""))
        throw new Error("--from requires a full 32-character checkpoint ID.")
      if (
        restoreArguments.length ||
        [...present].some(
          (flag) => !["list", "from", "json", "profile", "help", "version"].includes(flag)
        )
      )
        throw new Error("Invalid options for recovery list.")
      return { action: "restore", operation: "recovery-list", values: parsed.values, present }
    }
    if (present.has("list")) {
      if (
        parsed.values.list !== true ||
        restoreArguments.length !== 0 ||
        parsed.values.instance !== undefined ||
        [...present].some((name) => !["list", "json", "profile", "help", "version"].includes(name))
      ) {
        throw new Error("Usage: /ompi restore --list [--json] [--profile NAME]")
      }
      return {
        action: "restore",
        operation: "list",
        values: parsed.values,
        present,
      }
    }

    if (
      restoreArguments.length > 1 ||
      parsed.values.instance !== undefined ||
      present.has("json") ||
      (parsed.values.json && parsed.values.list !== true)
    ) {
      throw new Error("Usage: /ompi restore [NAME] [--profile NAME]")
    }
    if ([...present].some((name) => !["profile", "help", "version"].includes(name))) {
      throw new Error("Usage: /ompi restore [NAME] [--profile NAME]")
    }
    if (restoreArguments[0]) validateRestoreName(restoreArguments[0])
    return {
      action: "restore",
      operation: restoreArguments[0] ? "named" : "menu",
      name: restoreArguments[0],
      values: parsed.values,
      present,
    }
  }
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
    throw new Error(`Usage: /${COMMAND} instances list|restart|cleanup [options]`)
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
    throw new Error(`Usage: /${COMMAND} instances list|restart|cleanup [options]`)
  }

  const actionToken = positionTokens[1]
  if (
    actionToken &&
    parsed.tokens.some(
      (token) =>
        token.kind === "option" && token.index > rootToken.index && token.index < actionToken.index
    )
  ) {
    throw new Error(`Usage: /${COMMAND} instances list|restart|cleanup [options]`)
  }
  const action = positionals.shift() ?? "list"
  if (positionals.length > 0 || !["list", "restart", "cleanup"].includes(action)) {
    throw new Error(`Usage: /${COMMAND} instances list|restart|cleanup [options]`)
  }
  if (
    action === "cleanup" &&
    [...present].some((name) => !["profile", "json", "help", "version"].includes(name))
  ) {
    throw new Error("Usage: /ompi instances cleanup [--profile NAME] [--json]")
  }
  if (present.has("list")) {
    throw new Error("--list applies only to restore.")
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

function scopeRestoreInstanceIds(completionIds, tokens, defaultScope) {
  try {
    const scope = getRestoreScope(selectedProfile(tokens), defaultScope)
    return completionIds.get(scope.id) ?? new Set()
  } catch {
    return new Set()
  }
}

function scopeSavedNames(completionNames, tokens, defaultScope) {
  try {
    const scope = getRestoreScope(selectedProfile(tokens), defaultScope)
    return completionNames.get(scope.id) ?? []
  } catch {
    return []
  }
}

function scopeRecoveryIds(recoveryIds, tokens, defaultScope) {
  try {
    const scope = getRestoreScope(selectedProfile(tokens), defaultScope)
    return recoveryIds.get(scope.id) ?? { checkpoints: [], slots: [] }
  } catch {
    return { checkpoints: [], slots: [] }
  }
}

function restorePositionals(tokens) {
  const positionals = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === "--profile" || token === "--instance") {
      index += 1
      continue
    }
    if (token.startsWith("--") || token === "-h") continue
    positionals.push({ value: token, index })
  }
  return positionals
}

function getRestoreCompletions(
  completedTokens,
  tokenPrefix,
  completionIds,
  completionNames,
  profileNames,
  cwd,
  defaultScope,
  recoveryIds
) {
  const tokens = completedTokens.slice(1)
  if (tokens.at(-1) === "--from") {
    return completionValues(
      scopeRecoveryIds(recoveryIds, completedTokens, defaultScope).checkpoints.map((id) =>
        completionItem(id)
      ),
      completedTokens,
      tokenPrefix
    )
  }
  if (tokens.at(-1) === "--slot") {
    return completionValues(
      scopeRecoveryIds(recoveryIds, completedTokens, defaultScope).slots.map((id) =>
        completionItem(id)
      ),
      completedTokens,
      tokenPrefix
    )
  }
  if (tokenPrefix.startsWith("--from=")) {
    return completionValues(
      scopeRecoveryIds(recoveryIds, completedTokens, defaultScope).checkpoints.map((id) =>
        completionItem(`--from=${id}`)
      ),
      completedTokens,
      tokenPrefix
    )
  }
  if (tokenPrefix.startsWith("--slot=")) {
    return completionValues(
      scopeRecoveryIds(recoveryIds, completedTokens, defaultScope).slots.map((id) =>
        completionItem(`--slot=${id}`)
      ),
      completedTokens,
      tokenPrefix
    )
  }
  const saveAction = tokens[0] === "save"
  if (tokens.at(-1) === "--profile") {
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
  if (tokens.at(-1) === "--instance") {
    return completionValues(
      [...scopeRestoreInstanceIds(completionIds, completedTokens, defaultScope)].map((id) =>
        completionItem(id)
      ),
      completedTokens,
      tokenPrefix
    )
  }
  if (tokenPrefix.startsWith("--instance=")) {
    const idPrefix = tokenPrefix.slice("--instance=".length)
    const argumentPrefix = `${completedTokens.join(" ")} `
    return [...scopeRestoreInstanceIds(completionIds, completedTokens, defaultScope)]
      .filter((id) => id.startsWith(idPrefix))
      .map((id) => completionItem(`${argumentPrefix}--instance=${id}`))
  }

  if (saveAction) {
    const saveName = restorePositionals(tokens.slice(1))[0]
    if (!saveName) {
      if (!tokenPrefix.startsWith("-")) return []
      return completionValues(
        RESTORE_SAVE_COMPLETIONS.map((value) => completionItem(value)),
        completedTokens,
        tokenPrefix
      )
    }
    const usedOptions = new Set(
      tokens.filter((token) => token.startsWith("--")).map((token) => token.slice(2).split("=")[0])
    )
    const options = RESTORE_SAVE_COMPLETIONS.filter((option) => {
      const name = option.replace(/^--/, "")
      return !usedOptions.has(name)
    })
    return completionValues(
      options.map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }

  const namedSession = restorePositionals(tokens)[0]
  if (namedSession) {
    const optionTokens = tokens.slice(namedSession.index + 1)
    const usedOptions = new Set(
      optionTokens
        .filter((token) => token.startsWith("--") || token === "-h")
        .map((token) => (token === "-h" ? "help" : token.slice(2).split("=")[0]))
    )
    const options = ["--profile", "--help", "-h", "--version"].filter((option) => {
      const name = option === "-h" ? "help" : option.slice(2)
      return !usedOptions.has(name)
    })
    return completionValues(
      options.map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }

  const usedOptions = new Set(
    tokens
      .filter((token) => token.startsWith("--") || token === "-h")
      .map((token) => (token === "-h" ? "help" : token.slice(2).split("=")[0]))
  )
  let optionCompletions = RESTORE_COMPLETIONS
  if (usedOptions.has("list")) {
    optionCompletions = RESTORE_LIST_COMPLETIONS
  } else if (usedOptions.has("history")) {
    optionCompletions = RESTORE_HISTORY_COMPLETIONS
  }
  const options = optionCompletions.filter((option) => {
    const name = option === "-h" ? "help" : option.replace(/^--/, "")
    return !usedOptions.has(name)
  })
  const recoveryOperations = ["checkpoint", "history", "export", "import-legacy", "slot", "from"]
  let names = []
  if (!recoveryOperations.some((name) => usedOptions.has(name))) {
    names = scopeSavedNames(completionNames, completedTokens, defaultScope).map(
      ({ name, unavailable }) =>
        completionItem(
          name,
          unavailable ? `${name} (unavailable: ${safeTerminalText(unavailable)})` : name
        )
    )
  }
  return completionValues(
    [...names, ...options.map((value) => completionItem(value))],
    completedTokens,
    tokenPrefix
  )
}

function getArgumentCompletions(
  argumentText,
  completionIds,
  completionNames,
  profileNames,
  cwd,
  defaultScope,
  recoveryIds
) {
  const trailingSpace = /\s$/.test(argumentText)
  const tokens = argumentText.trim() ? argumentText.trim().split(/\s+/) : []
  let tokenPrefix = trailingSpace ? "" : (tokens.pop() ?? "")
  const completedTokens = trailingSpace ? tokens : [...tokens]
  const completedActionOrOption =
    tokenPrefix === "instances" ||
    ["restore", "list", "restart", "cleanup", "take-over"].includes(tokenPrefix) ||
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
  if (completedTokens[0] === "restore") {
    return getRestoreCompletions(
      completedTokens,
      tokenPrefix,
      completionIds,
      completionNames,
      profileNames,
      cwd,
      defaultScope,
      recoveryIds
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

  const explicitAction = ["list", "restart", "cleanup"].includes(completedTokens[1])
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

  let options = RESTART_COMPLETIONS
  if (action === "list") {
    options = LIST_COMPLETIONS
  } else if (action === "cleanup") {
    options = CLEANUP_COMPLETIONS
  }
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

function outcomeSummary(rows) {
  const counts = new Map()
  for (const row of rows) {
    const label = row.status === "online" ? "reachable" : row.status
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  if (rows.length === 0) {
    return "No participating instances in this scope."
  }

  return [...counts].map(([label, count]) => `${count} ${label}`).join(", ")
}

function notifyRows(ctx, rows, json) {
  const hasFailure = rows.some((row) =>
    ["failed", "unknown", "unreachable", "restarting", "waiting"].includes(row.status)
  )
  if (json) {
    ctx.ui.notify(JSON.stringify(rows), hasFailure ? "warning" : "info")
    return
  }

  const lines = [outcomeSummary(rows), formatRows(rows)]
  if (rows.some((row) => row.status === "unreachable")) {
    lines.push(
      "Unreachable registrations may be stale. Run /ompi instances cleanup for safe cleanup."
    )
  }

  ctx.ui.notify(lines.filter(Boolean).join("\n"), hasFailure ? "warning" : "info")
}

function safeTerminalText(value) {
  return String(value).replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
}

function cleanupSummary(results) {
  if (results.length === 0) {
    return "No stale instance records or sockets found."
  }

  const counts = new Map()
  for (const result of results) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1)
  }
  return [...counts].map(([status, count]) => `${count} ${status}`).join(", ")
}

function notifyCleanup(ctx, results, json) {
  const hasFailure = results.some((result) => result.status === "failed")
  if (json) {
    ctx.ui.notify(JSON.stringify(results), hasFailure ? "warning" : "info")
    return
  }

  const lines = [cleanupSummary(results)]
  for (const result of results) {
    const line = `${result.instanceId.slice(0, 12)} ${result.status}: ${result.reason}`
    lines.push(
      line.replace(
        /[\u0000-\u001f\u007f-\u009f]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
    )
  }
  ctx.ui.notify(lines.join("\n"), hasFailure ? "warning" : "info")
}

function renderPeerProgress(ctx, rows, started, frame) {
  const spinner = ["|", "/", "-", "\\"][frame % 4]
  const elapsed = Math.floor((Date.now() - started) / 1000)
  const lines = [`Peer restarts: ${outcomeSummary(rows)} (${elapsed}s)`]
  for (const row of rows) {
    const pending = row.status === "waiting" || row.status === "restarting"
    let marker = "!"
    let color = "error"
    if (pending) {
      marker = spinner
      color = "accent"
    } else if (row.status === "restarted") {
      marker = "+"
      color = "success"
    }

    const line = `${marker} ${formatRows([row])}`
    lines.push(process.env.NO_COLOR === undefined ? ctx.ui.theme.fg(color, line) : line)
  }

  lines.push("OMP owns settlement. Ctrl-C stops watching, not accepted restarts.")
  if (rows.some((row) => row.status === "waiting")) {
    lines.push(
      "Waiting: a first saved response, active turns, queued work or jobs may defer restart."
    )
  }
  if (rows.some((row) => row.status === "unreachable")) {
    lines.push("Possibly stale: run /ompi instances cleanup (safe, explicit cleanup).")
  }
  ctx.ui.setWidget(PROGRESS_WIDGET, lines, { placement: "aboveEditor" })
}

export function registerOmpiCommand(pi, { getRuntime = () => undefined } = {}) {
  const keybindings = pi.pi.KeybindingsManager.inMemory({ "app.clear": "ctrl+c" })
  const completionIds = new Map()
  const completionNames = new Map()
  const recoveryIds = new Map()
  let completionCwd
  let profileNames = ["default"]

  async function refreshProfileNames(scope) {
    try {
      profileNames = await listProfileNames(scope)
    } catch {
      profileNames = [...new Set(["default", scope.profile])]
    }
    return profileNames
  }

  async function refreshSavedNameCompletions(profiles) {
    const managedScope = getRuntime()?.launch.scope
    for (const profile of profiles) {
      let selectedScope
      try {
        selectedScope = getRestoreScope(profile, managedScope)
        const saved = await listSavedSessions(selectedScope)
        const checkpoints = await listRecoveryCheckpoints(selectedScope)
        completionNames.set(selectedScope.id, saved)
        const slots = await listRecoverySlotIds(selectedScope)
        recoveryIds.set(selectedScope.id, {
          checkpoints: checkpoints.map((checkpoint) => checkpoint.checkpointId),
          slots,
        })
      } catch {
        if (selectedScope) {
          completionNames.set(selectedScope.id, [])
          recoveryIds.set(selectedScope.id, { checkpoints: [], slots: [] })
        }
      }
    }
  }

  async function refreshCompletionIds(ctx, profile) {
    completionCwd = ctx.cwd
    let scope
    let restoreScope
    try {
      scope = getScope({ cwd: ctx.cwd, profile: normalizeProfile(profile) })
      restoreScope = getRestoreScope(profile, getRuntime()?.launch.scope)
      const profiles = await refreshProfileNames(scope)
      await refreshSavedNameCompletions(profiles)
      const transport = await createTransport(scope)
      const rows = await listInstances(transport)
      replaceCompletionIds(scope, rows, completionIds)
      if (restoreScope.id !== scope.id) {
        const restoreTransport = await createTransport(restoreScope)
        const restoreRows = await listInstances(restoreTransport)
        replaceCompletionIds(restoreScope, restoreRows, completionIds)
      }
    } catch {
      if (scope) {
        completionIds.set(scope.id, new Set())
      }
      if (restoreScope) {
        completionIds.set(restoreScope.id, new Set())
      }
    }
  }

  const restoreCommand = createRestoreCommand(pi, { getRuntime, refreshCompletionIds })

  pi.registerCommand(COMMAND, {
    description: "Control participating instances, named restores, or manual takeover",
    getArgumentCompletions(argumentText) {
      return getArgumentCompletions(
        argumentText,
        completionIds,
        completionNames,
        profileNames,
        completionCwd,
        getRuntime()?.launch.scope,
        recoveryIds
      )
    },
    async handler(args, ctx) {
      if (!isMainTerminal(ctx)) {
        ctx.ui.notify("Instance control requires a main OMP terminal.", "error")
        return
      }

      completionCwd = ctx.cwd
      try {
        const { action, operation, name, values, present } = parseOmpiArguments(args)
        if (action === "help") {
          ctx.ui.notify(
            [
              "Usage: /ompi instances [list|restart|cleanup] [options]",
              "Restart requires exactly one explicit --all or --instance selector. Listing is the default action.",
              "Cleanup removes only safely confirmed stale records and endpoints; it supports --profile NAME and --json.",
              "/ompi restore [NAME] or --slot ID selects a managed recovery slot, prepares a shell command, and confirms graceful exit.",
              "/ompi restore save NAME [--instance FULL_ID] [--profile NAME] creates an optional immutable name.",
              "/ompi restore --list [--json] [--from CHECKPOINT] [--profile NAME] lists recovery candidates.",
              "/ompi restore --checkpoint saves membership; --history [--json] lists retained checkpoints.",
              "/ompi restore --from CHECKPOINT selects its members; --export prints reviewed commands.",
              "/ompi restore --import-legacy [PATH] imports review-only legacy data without executing shell text.",
              "/ompi take-over prepares the current saved session for manual relaunch under ompi.",
              "Copy a prepared command before graceful exit, wait for your shell, then paste it. No terminal windows open automatically.",
            ].join("\n"),
            "info"
          )
          return
        }
        if (action === "version") {
          ctx.ui.notify(`omp-instance-control ${packageJson.version}`, "info")
          return
        }
        if (action === "restore") {
          await restoreCommand(ctx, { operation, name, values })
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
        if (action === "cleanup") {
          const results = await transport.cleanupRecords()
          notifyCleanup(ctx, results, values.json === true)
          return
        }

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
            let lastProgress = rows.map((row) => ({
              ...row,
              status: row.status === "accepted" ? "waiting" : row.status,
            }))
            const started = Date.now()
            let frame = 0
            const renderProgress = () => renderPeerProgress(ctx, lastProgress, started, frame++)
            const stopListening = ctx.ui.onTerminalInput((data) => {
              if (keybindings.matches(data, "app.clear")) {
                controller.abort(new Error("Restart observation cancelled."))
                return { consume: true }
              }
              return undefined
            })
            const animation = setInterval(renderProgress, 125)
            try {
              const watchedRows = await waitForRestarts(transport, acceptedRows, {
                signal: controller.signal,
                onProgress(progressRows) {
                  lastProgress = rowsFromProgress(
                    rows,
                    progressRows.map((row) => ({ ...row }))
                  )
                  renderProgress()
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
              clearInterval(animation)
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
        ctx.ui.notify(safeTerminalText(error.message), "error")
      }
    },
  })

  return refreshCompletionIds
}
