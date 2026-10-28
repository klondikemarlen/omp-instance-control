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
import { requestWrapperRestart } from "./restart.js"

const COMMAND = "ompi"
const PROGRESS_WIDGET = "ompi-restart-progress"
const ROOT_COMPLETIONS = ["help", "version", "list", "restart", "cleanup", "restore", "take-over"]
const LIST_COMPLETIONS = ["--profile", "--json"]
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
]
const RESTORE_LIST_COMPLETIONS = ["--json", "--from", "--profile"]
const RESTORE_SAVE_COMPLETIONS = ["--instance", "--profile"]
const RESTORE_HISTORY_COMPLETIONS = ["--json", "--profile"]

const RESTART_COMPLETIONS = ["--profile", "--json", "--no-wait"]

function isMainTerminal(ctx) {
  return ctx.agent.kind === "main" && ctx.mode === "tui"
}

const BOOLEAN_OPTIONS = new Set([
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
    throw new Error("Choose either help or version.")
  }
  if (positionals.length === 0) {
    if (parsed.values.help) return { action: "help", values: parsed.values, present }
    if (parsed.values.version) return { action: "version", values: parsed.values, present }
    if (present.size === 0) return { action: "help", values: parsed.values, present }
    throw new Error(`Usage: /${COMMAND} [help [COMMAND]|version|list|restart ID|all|cleanup]`)
  }

  const positionTokens = parsed.tokens.filter((token) => token.kind === "positional")
  const rootToken = positionTokens[0]
  if (positionals[0] === "help") {
    if (
      positionals.length > 2 ||
      [...present].some((name) => !["help", "version"].includes(name)) ||
      (positionals.length === 2 &&
        !["list", "restart", "cleanup", "restore", "take-over"].includes(positionals[1]))
    ) {
      throw new Error("Usage: /ompi help [list|restart|cleanup|restore|take-over]")
    }
    return {
      action: "help",
      helpTarget: positionals[1],
      values: parsed.values,
      present,
    }
  }
  if (positionals[0] === "version") {
    if (positionals.length !== 1 || present.size !== 0) {
      throw new Error("Usage: /ompi version")
    }
    return { action: "version", values: parsed.values, present }
  }

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
      return { action: "help", helpTarget: "restore", values: parsed.values, present }
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
      return { action: "help", helpTarget: "take-over", values: parsed.values, present }
    }
    if (parsed.values.version) {
      return { action: "version", values: parsed.values, present }
    }
    return { action: "take-over", values: parsed.values, present }
  }

  if (positionals[0] === "restart") {
    const target = positionals[1]
    if (
      positionals.length > 2 ||
      [...present].some(
        (name) => !["profile", "json", "no-wait", "help", "version"].includes(name)
      ) ||
      parsed.values.instance !== undefined
    ) {
      throw new Error("Usage: /ompi restart [ID|all] [--profile NAME] [--json] [--no-wait]")
    }
    if (parsed.values.help) {
      return { action: "help", helpTarget: "restart", values: parsed.values, present }
    }
    if (parsed.values.version) {
      return { action: "version", values: parsed.values, present }
    }
    if (!target) {
      if (["profile", "json", "no-wait"].some((option) => present.has(option))) {
        throw new Error("Peer restart options require an ID or all target.")
      }
      return { action: "restart-wrapper", values: parsed.values, present }
    }
    if (target !== "all" && !/^[a-f0-9]{1,32}$/.test(target)) {
      throw new Error(
        "Restart target must be 'all' or a 1-32 character lowercase hexadecimal instance ID prefix."
      )
    }
    return { action: "restart", target, values: parsed.values, present }
  }

  const action = positionals[0]
  if (!["list", "cleanup"].includes(action) || positionals.length !== 1) {
    throw new Error(`Usage: /${COMMAND} [help [COMMAND]|version|list|restart ID|all|cleanup]`)
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
    throw new Error(`Usage: /${COMMAND} list|cleanup [options]`)
  }
  if ([...present].some((name) => !["profile", "json", "help", "version"].includes(name))) {
    throw new Error(`Usage: /ompi ${action} [--profile NAME] [--json]`)
  }
  if (parsed.values.help) {
    return { action: "help", helpTarget: action, values: parsed.values, present }
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

function completionContext(tokens) {
  const valueOptions = new Set(["profile", "instance", "from", "slot", "import-legacy"])
  const options = new Set()
  const positionals = []
  let pendingValue

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === "--") return { options, positionals, ended: true }
    if (!token.startsWith("-")) {
      positionals.push(token)
      continue
    }

    const name = token === "-h" ? "help" : token.slice(2).split("=")[0]
    options.add(name)
    if (!valueOptions.has(name) || token.includes("=")) continue

    const next = tokens[index + 1]
    if (next !== undefined && !next.startsWith("-")) {
      index += 1
    } else if (next === undefined) {
      pendingValue = name
    }
  }
  return { options, positionals, pendingValue, ended: false }
}

function getRestoreCompletions(
  completedTokens,
  tokenPrefix,
  context,
  completionIds,
  completionNames,
  defaultScope,
  recoveryIds
) {
  const { options, positionals, pendingValue } = context
  const operations = ["list", "checkpoint", "history", "export", "import-legacy", "slot"]
  const selected = operations.filter((operation) => options.has(operation))
  if (selected.length > 1) return []
  const operation = selected[0]
  if (options.has("from") && operation && !["list", "export"].includes(operation)) return []

  const save = positionals[0] === "save"
  const named = positionals.length > 0 && !save
  if ((save || named) && (operation || options.has("from"))) return []
  if (positionals.length > (save ? 2 : 1)) return []

  if (pendingValue === "instance" || tokenPrefix.startsWith("--instance=")) {
    if (!save) return []
    const prefix = tokenPrefix.startsWith("--instance=") ? "--instance=" : ""
    return completionValues(
      [...scopeRestoreInstanceIds(completionIds, completedTokens, defaultScope)].map((id) =>
        completionItem(`${prefix}${id}`)
      ),
      completedTokens,
      tokenPrefix
    )
  }
  for (const selector of ["from", "slot"]) {
    const prefix = `--${selector}=`
    if (pendingValue !== selector && !tokenPrefix.startsWith(prefix)) continue
    if (save || named) return []
    if (selector === "from" && operation && !["list", "export"].includes(operation)) return []
    if (selector === "slot" && (options.has("from") || (operation && operation !== "slot")))
      return []

    const ids = scopeRecoveryIds(recoveryIds, completedTokens, defaultScope)
    const values = selector === "from" ? ids.checkpoints : ids.slots
    const inline = tokenPrefix.startsWith(prefix)
    return completionValues(
      values.map((id) => completionItem(inline ? `${prefix}${id}` : id)),
      completedTokens,
      tokenPrefix
    )
  }
  if (pendingValue === "import-legacy" && !tokenPrefix.startsWith("-")) return []

  let candidates = RESTORE_COMPLETIONS
  if (save) {
    candidates = RESTORE_SAVE_COMPLETIONS
  } else if (named || ["checkpoint", "import-legacy", "slot"].includes(operation)) {
    candidates = ["--profile"]
  } else if (operation === "list") {
    candidates = RESTORE_LIST_COMPLETIONS
  } else if (operation === "history") {
    candidates = RESTORE_HISTORY_COMPLETIONS
  } else if (operation === "export") {
    candidates = ["--from", "--profile"]
  } else if (options.has("from")) {
    candidates = ["--list", "--export", "--profile"]
  } else if (options.has("json")) {
    candidates = ["--list", "--history", "--profile"]
  }
  if (tokenPrefix.startsWith("-")) {
    return completionValues(
      candidates
        .filter((option) => option.startsWith("--") && !options.has(option.slice(2)))
        .map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }
  if (positionals.length || operation || options.has("from") || options.has("json")) return []

  const names = scopeSavedNames(completionNames, completedTokens, defaultScope).map(
    ({ name, unavailable }) =>
      completionItem(
        name,
        unavailable ? `${name} (unavailable: ${safeTerminalText(unavailable)})` : name
      )
  )
  return completionValues([completionItem("save"), ...names], completedTokens, tokenPrefix)
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
  const tokenPrefix = trailingSpace ? "" : (tokens.pop() ?? "")
  const completedTokens = trailingSpace ? tokens : [...tokens]
  const context = completionContext(completedTokens.slice(1))
  if (context.ended || context.options.has("help") || context.options.has("version")) return []

  if (completedTokens.length === 0) {
    return completionValues(
      ROOT_COMPLETIONS.map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }
  const command = completedTokens[0]
  if (command === "help") {
    if (completedTokens.length > 1) return []
    return completionValues(
      ["list", "restart", "cleanup", "restore", "take-over"].map((value) => completionItem(value)),
      completedTokens,
      tokenPrefix
    )
  }
  if (!["restore", "restart", "list", "cleanup"].includes(command)) return []

  if (context.pendingValue === "profile" || tokenPrefix.startsWith("--profile=")) {
    const inline = tokenPrefix.startsWith("--profile=")
    return completionValues(
      profileNames.map((name) => completionItem(inline ? `--profile=${name}` : name, name)),
      completedTokens,
      tokenPrefix
    )
  }
  if (command === "restore") {
    return getRestoreCompletions(
      completedTokens,
      tokenPrefix,
      context,
      completionIds,
      completionNames,
      defaultScope,
      recoveryIds
    )
  }
  if (context.pendingValue) return []
  if (context.positionals.length > (command === "restart" ? 1 : 0)) return []
  if (command === "restart" && context.positionals.length === 0 && !tokenPrefix.startsWith("-")) {
    return completionValues(
      [
        completionItem("all"),
        ...[...scopeInstanceIds(completionIds, cwd, completedTokens)].map((id) =>
          completionItem(id)
        ),
      ],
      completedTokens,
      tokenPrefix
    )
  }
  if (!tokenPrefix.startsWith("-")) return []

  const candidates = command === "restart" ? RESTART_COMPLETIONS : LIST_COMPLETIONS
  return completionValues(
    candidates
      .filter((option) => !context.options.has(option.slice(2)))
      .map((value) => completionItem(value)),
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
    ["blocked", "failed", "unknown", "unreachable", "restarting", "waiting"].includes(row.status)
  )
  if (json) {
    ctx.ui.notify(JSON.stringify(rows), hasFailure ? "warning" : "info")
    return
  }

  const lines = [outcomeSummary(rows), formatRows(rows)]
  if (rows.some((row) => row.status === "unreachable")) {
    lines.push("Unreachable registrations may be stale. Run /ompi cleanup for safe cleanup.")
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
    lines.push("Possibly stale: run /ompi cleanup (safe, explicit cleanup).")
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
    description: "Control this OMP session and peer instances, recovery, or manual takeover",
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
        const { action, operation, name, helpTarget, target, values } = parseOmpiArguments(args)
        if (action === "help") {
          const help = {
            root: [
              "Usage: /ompi COMMAND",
              "list                 Show participating terminals",
              "restart [ID|all]      Restart this terminal, one peer, or all in scope",
              "restore [NAME]       Choose a recoverable conversation",
              "cleanup              Remove safely confirmed stale registrations",
              "take-over            Prepare a plain-OMP session for manual relaunch",
              "help [COMMAND]       Show usage and advanced options",
              "version              Show the controller version",
            ],
            list: ["Usage: /ompi list [--profile NAME] [--json]"],
            restart: [
              "Usage: /ompi restart [ID|all] [--profile NAME] [--json] [--no-wait]",
              "ID may be a unique 1-32 character lowercase hexadecimal instance-ID prefix.",
              "Every target replaces its native ompi wrapper and OMP using the installed code.",
              "With no target, select only this terminal. Ctrl-C stops watching, not accepted requests.",
              "Restarts inject zero model messages. OMP settles active work and typed instructions queued while busy before the session reopens for input.",
              "Explicit exit suppresses relaunch; Ctrl-C stops watching only.",
            ],
            cleanup: ["Usage: /ompi cleanup [--profile NAME] [--json]"],
            restore: [
              "Usage: /ompi restore [NAME] [--profile NAME]",
              "/ompi restore save NAME [--instance ID] [--profile NAME]",
              "/ompi restore --list [--json] [--from CHECKPOINT]",
              "/ompi restore --history [--json]",
              "/ompi restore --checkpoint",
              "/ompi restore --slot ID",
              "/ompi restore --from CHECKPOINT",
              "/ompi restore --export [--from CHECKPOINT]",
              "/ompi restore --import-legacy [PATH]",
              "All recovery operations accept --profile NAME.",
              "Selection prepares a command to copy before graceful exit; paste it at the shell.",
            ],
            "take-over": [
              "/ompi take-over prepares the current saved session for manual relaunch under ompi.",
            ],
          }
          const lines = helpTarget ? help[helpTarget] : help.root
          ctx.ui.notify(lines.join("\n"), "info")
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
            throw new Error("This session already runs under ompi; use /ompi restart.")
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

        if (action === "restart-wrapper") {
          await requestWrapperRestart(getRuntime())
          ctx.ui.notify(
            "Wrapper restart accepted. OMP will shut down at a safe boundary; the owning ompi launcher will replace it.",
            "info"
          )
          return
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
          all: target === "all",
          instanceId: target === "all" ? undefined : target,
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
