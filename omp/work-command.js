import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import path from "node:path"
import { parseArgs, promisify } from "node:util"

import { validateInstanceId } from "../protocol/index.js"

const execFileAsync = promisify(execFile)
// The native work help banner distinguishes a capable wrapper from an older ompi on PATH.
const WORK_HELP_MARKER = "Usage: ompi control work"

const WORK_USAGE = {
  list: "/ompi work list [--profile NAME] [--json]",
  find: "/ompi work find URL [--profile NAME] [--json]",
  set: "/ompi work set [--branch NAME] URL SUMMARY",
  clear: "/ompi work clear",
}

export const WORK_OPERATIONS = Object.keys(WORK_USAGE)
export const WORK_HELP = [
  `Usage: ${WORK_USAGE.list}`,
  WORK_USAGE.find,
  WORK_USAGE.set,
  WORK_USAGE.clear,
  "URL must identify a GitHub issue or pull request. List and find show every claim or match.",
  "Set and clear affect only this managed saved conversation in its launch scope.",
  "Everything after URL in set is literal summary text, not shell syntax.",
]

export async function workCommand(args, ctx, getRuntime) {
  const operation = parseWorkArguments(args)
  if (operation === null) return WORK_HELP.join("\n")

  const cwd = ctx.cwd
  const runtime = getRuntime()
  const isMutation = operation.name === "set" || operation.name === "clear"
  const argv = ["control", "work", operation.name]
  let session
  if (isMutation) {
    session = requireManagedSession(runtime, ctx)
    argv.push(`--expect-session-id=${session.id}`, `--expect-session-file=${session.file}`)
  }

  argv.push(...operation.options, "--")
  if (isMutation) argv.push(runtime.instanceId)
  argv.push(...operation.positionals)

  await requireWorkingDirectory(cwd)
  const env = workEnvironment(cwd, runtime?.launch.scope, operation.profile)
  const executable = await resolveNativeExecutable(runtime, env)
  await requireWorkSupport(executable, { cwd, env })

  if (isMutation) {
    const currentRuntime = getRuntime()
    const currentSession = requireManagedSession(currentRuntime, ctx)
    if (
      currentRuntime !== runtime ||
      currentSession.id !== session.id ||
      currentSession.file !== session.file ||
      ctx.cwd !== cwd
    ) {
      throw new Error("The managed session changed; run /ompi work again in the intended session.")
    }
  }

  try {
    const { stdout } = await execFileAsync(executable, argv, { cwd, env })
    return stdout.trimEnd()
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("The native ompi executable or current working directory disappeared.", {
        cause: error,
      })
    }
    const diagnostic = error.stderr?.trim()
    throw new Error(diagnostic || `Native ompi work failed (${error.code ?? "unknown error"}).`, {
      cause: error,
    })
  }
}

function parseWorkArguments(args) {
  const tokens = args.matchAll(/\S+/g)
  tokens.next() // work
  const name = tokens.next().value?.[0]
  if (!name || ["help", "--help", "-h"].includes(name)) {
    return null
  }

  if (!WORK_OPERATIONS.includes(name)) {
    throw new Error(`Unknown /ompi work operation: ${name}; use /ompi help work.`)
  }

  const argument = tokens.next().value
  if (["--help", "-h"].includes(argument?.[0]) && tokens.next().done) {
    return null
  }

  if (name === "clear") {
    if (argument) {
      throw new Error(`Usage: ${WORK_USAGE.clear} (this managed session only).`)
    }

    return {
      name,
      options: [],
      positionals: [],
    }
  }
  if (name === "set") {
    return parseWorkSet(args, argument, tokens)
  }

  const optionTokens = argument ? [argument[0]] : []
  for (const [token] of tokens) {
    optionTokens.push(token)
  }
  const { values, positionals } = parseArgs({
    args: optionTokens,
    options: {
      profile: {
        type: "string",
      },
      json: {
        type: "boolean",
      },
    },
    allowPositionals: true,
  })
  if (positionals.length !== (name === "find" ? 1 : 0)) {
    throw new Error(`Usage: ${WORK_USAGE[name]}`)
  }

  const options = []
  if (values.profile !== undefined) options.push(`--profile=${values.profile}`)
  if (values.json) options.push("--json")

  return {
    name,
    options,
    positionals,
    profile: values.profile,
  }
}

function parseWorkSet(args, firstArgument, tokens) {
  const options = []
  let url = firstArgument
  if (firstArgument?.[0] === "--branch") {
    const branch = tokens.next().value?.[0]
    if (!branch || branch.startsWith("-")) {
      throw new Error("--branch requires a branch name.")
    }

    options.push(`--branch=${branch}`)
    url = tokens.next().value
  }
  if (!url || url[0].startsWith("-")) {
    throw new Error(`Usage: ${WORK_USAGE.set}`)
  }

  const summary = args.slice(url.index + url[0].length + 1)
  if (!summary.trim()) {
    throw new Error("/ompi work set requires a nonempty summary after URL.")
  }

  return {
    name: "set",
    options,
    positionals: [url[0], summary],
  }
}

function requireManagedSession(runtime, ctx) {
  if (!runtime?.launch.scope || runtime.closing) {
    throw new Error("/ompi work set and clear require this session to be running under ompi.")
  }

  validateInstanceId(runtime.instanceId)
  const id = ctx.sessionManager?.getSessionId?.()
  const file = ctx.sessionManager?.getSessionFile?.()
  if (typeof id !== "string" || !id || typeof file !== "string" || !path.isAbsolute(file)) {
    throw new Error(
      "/ompi work set and clear require a saved conversation with an absolute transcript path."
    )
  }

  const managedContext = runtime.ctx
  if (
    !managedContext ||
    managedContext.cwd !== ctx.cwd ||
    managedContext.sessionManager?.getSessionId?.() !== id ||
    managedContext.sessionManager?.getSessionFile?.() !== file
  ) {
    throw new Error("This command no longer matches the managed session; run /ompi work again.")
  }

  return {
    id,
    file,
  }
}

async function requireWorkingDirectory(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new Error("/ompi work requires an absolute current working directory.")
  }

  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory")

    await access(cwd, constants.X_OK)
  } catch (error) {
    throw new Error(
      `The current working directory for /ompi work is unavailable: ${error.message}`,
      {
        cause: error,
      }
    )
  }
}

function workEnvironment(cwd, launchScope, profile) {
  const env = {
    ...process.env,
    PWD: cwd,
  }
  if (launchScope) {
    env.PI_CONFIG_DIR = launchScope.configRoot
    env.OMP_PROFILE = launchScope.profile
    env.PI_PROFILE = launchScope.profile
    if (!profile || profile === launchScope.profile) {
      env.PI_CODING_AGENT_DIR = launchScope.agentDir
    } else if (
      launchScope.profile !== "default" &&
      env.PI_CODING_AGENT_DIR === launchScope.agentDir
    ) {
      // A named-profile launch anchor is not a default-profile agent-directory override.
      delete env.PI_CODING_AGENT_DIR
    }
  }
  return env
}

async function resolveNativeExecutable(runtime, env) {
  if (runtime) {
    const executable = runtime.launch.native?.executable
    if (
      typeof executable !== "string" ||
      !path.isAbsolute(executable) ||
      !(await isExecutable(executable))
    ) {
      throw new Error(
        "The managed native ompi executable is unavailable; start a session with an updated ompi."
      )
    }
    return executable
  }

  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    // Do not search the conversation directory for a standalone controller.
    if (!path.isAbsolute(directory)) continue

    const candidate = path.join(directory, "ompi")
    if (await isExecutable(candidate)) return candidate
  }
  throw new Error("Native ompi was not found on PATH; install an ompi version with work support.")
}

async function isExecutable(executable) {
  try {
    if (!(await stat(executable)).isFile()) return false

    await access(executable, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function requireWorkSupport(executable, { cwd, env }) {
  try {
    const { stdout } = await execFileAsync(executable, ["control", "work", "--help"], {
      cwd,
      env,
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    })
    if (stdout.startsWith(WORK_HELP_MARKER)) return
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("The native ompi executable or current working directory disappeared.", {
        cause: error,
      })
    }
  }
  throw new Error(
    "This native ompi version does not report work support; update ompi and try again."
  )
}
