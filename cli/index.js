#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

import { formatRows, listInstances, restartInstances } from "./client.js"
import { launchOmp } from "../linux/launcher.js"
import { getScope } from "../protocol/index.js"
import { createTransport } from "../linux/transport.js"

const HELP = `Usage:
  omp-instance-control launch [OMP options] [message...]
  omp-instance-control instances list [--profile NAME] [--cwd PATH] [--json]
  omp-instance-control instances restart (--all | --instance ID) [--profile NAME] [--cwd PATH] [--json]

Launch options:
  --profile NAME             Select an OMP profile
  --cwd PATH                 Set the working directory
  --resume SESSION           Resume an OMP session
  --model NAME               Select a model
  --thinking LEVEL           Set thinking level
  --config PATH              Load config file (repeatable)
  --extension PATH           Load extension (repeatable)
  --session-dir PATH         Set session directory
  --no-title --no-lsp --no-pty --no-tools --no-skills --no-rules
  Interactive launches require Linux and a TTY. Resource-only extension reload is unavailable.

Instance commands:
  list                       Show discovered instances and status
  restart --all              Request restart for the discovered snapshot
  restart --instance ID      Request restart for one instance
  --json                     Print machine-readable JSON
  --help                     Show this help
`

const OPTION_DEFS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  profile: { type: "string" },
  cwd: { type: "string" },
  resume: { type: "string" },
  model: { type: "string" },
  thinking: { type: "string" },
  config: { type: "string", multiple: true },
  extension: { type: "string", multiple: true },
  "session-dir": { type: "string" },
  "no-title": { type: "boolean" },
  "no-lsp": { type: "boolean" },
  "no-pty": { type: "boolean" },
  "no-tools": { type: "boolean" },
  "no-skills": { type: "boolean" },
  "no-rules": { type: "boolean" },
  all: { type: "boolean" },
  instance: { type: "string" },
}

export async function main(args = process.argv.slice(2)) {
  const commandLine = parseArgs({ args, options: OPTION_DEFS, allowPositionals: true })
  const { values, positionals } = commandLine

  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }

  if (positionals[0] === "instances") {
    return runInstances(positionals.slice(1), values)
  }
  if (positionals[0] !== "launch") {
    throw new Error("Choose 'launch' or an 'instances' command.")
  }
  const launchOptions = new Set([
    "profile",
    "cwd",
    "resume",
    "model",
    "thinking",
    "config",
    "extension",
    "session-dir",
    "no-title",
    "no-lsp",
    "no-pty",
    "no-tools",
    "no-skills",
    "no-rules",
  ])
  if (Object.keys(values).some((key) => !launchOptions.has(key))) {
    throw new Error("Instance-control options are only valid with an instances command.")
  }

  return launchOmp({
    profile: values.profile,
    cwd: values.cwd,
    resume: values.resume,
    model: values.model,
    thinking: values.thinking,
    config: values.config ?? [],
    extension: values.extension ?? [],
    sessionDir: values["session-dir"],
    noTitle: values["no-title"],
    noLsp: values["no-lsp"],
    noPty: values["no-pty"],
    noTools: values["no-tools"],
    noSkills: values["no-skills"],
    noRules: values["no-rules"],
    messages: positionals.slice(1),
  })
}

async function runInstances(positionals, values) {
  const [action, ...extra] = positionals
  if (extra.length || !["list", "restart"].includes(action)) {
    throw new Error("Use 'instances list' or 'instances restart'.")
  }
  const allowedOptions = new Set(["help", "json", "profile", "cwd"])
  if (action === "restart") {
    allowedOptions.add("all")
    allowedOptions.add("instance")
  }
  if (Object.keys(values).some((key) => !allowedOptions.has(key))) {
    throw new Error("Only --profile, --cwd, and command-specific instance options are valid here.")
  }
  if (action === "restart" && Boolean(values.all) === Boolean(values.instance)) {
    throw new Error("Choose exactly one of --all or --instance <id>.")
  }
  const transport = await createTransport(getScope({ profile: values.profile, cwd: values.cwd }))
  const rows =
    action === "list"
      ? await listInstances(transport)
      : await restartInstances(transport, { all: values.all, instanceId: values.instance })
  if (values.json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`)
  } else {
    process.stdout.write(`${formatRows(rows)}\n`)
  }
  return rows.some((row) => ["failed", "unreachable", "unknown"].includes(row.status)) ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(
    (code) => {
      if (Number.isInteger(code) && code !== 0) process.exitCode = code
    },
    (error) => {
      process.stderr.write(`${error.message}\nUse --help for usage.\n`)
      process.exitCode = 2
    }
  )
}
