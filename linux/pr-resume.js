import { constants } from "node:fs"
import { open, opendir } from "node:fs/promises"
import path from "node:path"

const PR_URL =
  /^https:\/\/github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,19})$/
const SESSION_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([a-zA-Z0-9_-]{1,128})\.jsonl$/
// OMP stores main sessions one level below sessions/, in encoded cwd buckets.
const SESSION_BUCKET = /^(?:-.*|(?:home|tmp|abs)-.+-[a-f0-9]{64})$/
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
const TRANSCRIPT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const UNAVAILABLE_PATH = new Set(["EACCES", "ENOENT", "ENOTDIR", "ELOOP", "EPERM", "ESTALE"])
const HEADER_BYTES = 64 * 1024
const INITIAL_READ_BYTES = 4 * 1024
const RECORD_BYTES = 512 * 1024
const TRANSFER_MARKER = Buffer.from('"session-transfer"')
const ASSISTANT_ROLE = Buffer.from('"assistant"')
const GITHUB_CLI = Buffer.from("gh")
const OPAQUE_TRANSFER = Symbol("oversized transfer record")
const TITLE_SLOT_BYTES = 256
const CLAIM_EVIDENCE = "Explicit work claim"
const CREATE_EVIDENCE = "Created this pull request"

export async function findResumeCandidates(scope, url, claims = [], cwd = process.cwd()) {
  const lookup = createLookup(scope, url, claims, cwd)
  if (!lookup) {
    return []
  }

  const candidates = await withSessionsDirectory(lookup, async (sessions) => {
    const matches = []
    for await (const bucket of directoryEntries(sessions)) {
      if (!bucket.isDirectory() || !isSessionBucket(bucket.name)) {
        continue
      }

      await withBucket(sessions, bucket.name, async (directory) => {
        for await (const file of directoryEntries(directory)) {
          if (!file.isFile()) {
            continue
          }

          const candidate = await inspectTranscript(lookup, directory, bucket.name, file.name)
          if (candidate) matches.push(candidate)
        }
      })
    }
    return matches
  })
  return (candidates ?? []).sort((left, right) => {
    return (
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.sessionFile.localeCompare(right.sessionFile)
    )
  })
}

export async function revalidateResumeCandidate(scope, url, claims, candidate) {
  const lookup = createLookup(scope, url, claims, candidate?.cwd)
  if (!lookup || !isAbsolutePath(candidate?.sessionFile)) {
    return null
  }

  const [bucket, file, extra] = path
    .relative(lookup.sessionsRoot, candidate.sessionFile)
    .split(path.sep)
  if (!isSessionBucket(bucket) || !SESSION_FILE.test(file) || extra !== undefined) {
    return null
  }

  const refreshed = await withSessionsDirectory(lookup, (sessions) =>
    withBucket(sessions, bucket, (directory) => inspectTranscript(lookup, directory, bucket, file))
  )
  if (
    refreshed?.sessionId === candidate.sessionId &&
    refreshed.cwd === candidate.cwd &&
    refreshed.evidence === candidate.evidence
  ) {
    return refreshed
  }
  return null
}

function createLookup(scope, url, claims, cwd) {
  const canonicalURL = normalizePRResumeURL(url)
  if (
    !isAbsolutePath(scope?.agentDir) ||
    !/^[a-f0-9]{16}$/.test(scope.id) ||
    !canonicalURL ||
    !isAbsolutePath(cwd)
  ) {
    return null
  }

  const claimIdsByFile = new Map()
  for (const claim of claims ?? []) {
    if (
      claim?.version === 1 &&
      claim.scope === scope.id &&
      normalizePRResumeURL(claim.url) === canonicalURL &&
      typeof claim.sessionFile === "string"
    ) {
      claimIdsByFile.set(claim.sessionFile, claim.sessionId)
    }
  }
  return {
    sessionsRoot: path.join(scope.agentDir, "sessions"),
    url: canonicalURL,
    cwd,
    claimIdsByFile,
  }
}

function isAbsolutePath(value) {
  return isSafePathText(value) && path.isAbsolute(value) && path.resolve(value) === value
}

function isSafePathText(value) {
  return (
    typeof value === "string" && value.length <= 4096 && !/\p{Cc}|\p{Bidi_Control}/u.test(value)
  )
}

function isSessionBucket(name) {
  return isSafePathText(name) && SESSION_BUCKET.test(name)
}

export function normalizePRResumeURL(value) {
  const match = typeof value === "string" && PR_URL.exec(value)
  if (
    !match ||
    match[0] !== value ||
    match[2] === "." ||
    match[2] === ".." ||
    BigInt(match[3]) > 2n ** 64n - 1n
  ) {
    return null
  }
  return `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${match[3]}`
}

// Resolve each path segment relative to an open directory, never following a
// symlink even if a bucket is replaced between enumeration and open.
function descriptorPath(directory, name = "") {
  return `/proc/self/fd/${directory.fd}/${name}`
}

async function withSessionsDirectory({ sessionsRoot }, visit) {
  const agentDir = path.dirname(sessionsRoot)
  const components = sessionsRoot.slice(1).split(path.sep)
  const uid = process.getuid()
  let directory
  try {
    directory = await open("/", DIRECTORY_FLAGS)
    let current = ""
    for (const name of components) {
      current += `/${name}`
      const parent = directory
      directory = await open(descriptorPath(parent, name), DIRECTORY_FLAGS)
      await parent.close()
      const info = await directory.stat()
      const stickyTmp = current === "/tmp" && info.uid === 0 && (info.mode & 0o1000) !== 0
      const owned = info.uid === uid
      const writableByOthers = (info.mode & 0o022) !== 0
      if ((!owned && info.uid !== 0) || (writableByOthers && !stickyTmp)) {
        return null
      }

      if ((current === sessionsRoot || current === agentDir) && !owned) {
        return null
      }
    }
    return await visit(directory)
  } catch (error) {
    return unavailablePath(error)
  } finally {
    await directory?.close()
  }
}

async function withBucket(parent, name, visit) {
  let directory
  try {
    directory = await open(descriptorPath(parent, name), DIRECTORY_FLAGS)
    const info = await directory.stat()
    if (info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
      return null
    }

    return await visit(directory)
  } catch (error) {
    return unavailablePath(error)
  } finally {
    await directory?.close()
  }
}

async function* directoryEntries(directory) {
  const entries = await opendir(descriptorPath(directory))
  yield* entries
}

function unavailablePath(error) {
  if (UNAVAILABLE_PATH.has(error.code)) {
    return null
  }

  throw new Error("Could not read saved OMP sessions in this profile.", { cause: error })
}

async function inspectTranscript(lookup, directory, bucket, name) {
  const sessionId = SESSION_FILE.exec(name)?.[1]
  if (!sessionId) {
    return null
  }

  const sessionFile = path.join(lookup.sessionsRoot, bucket, name)
  const isClaimed = lookup.claimIdsByFile.get(sessionFile) === sessionId
  let transcript
  try {
    transcript = await open(descriptorPath(directory, name), TRANSCRIPT_FLAGS)
    const info = await transcript.stat()
    const hasOwnerAccess = (info.mode & 0o600) === 0o600
    const writableByOthers = (info.mode & 0o022) !== 0
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      !hasOwnerAccess ||
      writableByOthers
    ) {
      return null
    }

    const lines = readLines(transcript, info.size)
    let { value: headerLine } = await lines.next()
    let header = parseRecord(headerLine)
    if (headerLine?.length === TITLE_SLOT_BYTES - 1 && header?.type === "title" && header.v === 1) {
      const next = await lines.next(true)
      headerLine = next.value
      header = parseRecord(headerLine)
    }
    if (!headerLine || headerLine.length >= HEADER_BYTES || !isSessionHeader(header, sessionId)) {
      return null
    }

    // The host cannot switch across working directories. An explicit claim
    // may still identify one for the caller to explain without searching it.
    if (
      !isClaimed &&
      (header.cwd !== lookup.cwd || header.parentSession || header.continuationOf)
    ) {
      return null
    }

    const evidence = await findEvidence(lines, lookup.url, header, isClaimed)
    if (!evidence) {
      return null
    }

    const after = await transcript.stat()
    if (
      after.ctimeMs !== info.ctimeMs ||
      after.mtimeMs !== info.mtimeMs ||
      after.size !== info.size
    ) {
      return null
    }
    return {
      sessionId,
      sessionFile,
      cwd: header.cwd,
      evidence,
      updatedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    return unavailablePath(error)
  } finally {
    await transcript?.close()
  }
}

function isSessionHeader(header, sessionId) {
  return (
    header?.type === "session" &&
    header.id === sessionId &&
    isAbsolutePath(header.cwd) &&
    header.origin === undefined &&
    (header.version === undefined || [1, 2, 3].includes(header.version))
  )
}

function parseRecord(line) {
  if (!Buffer.isBuffer(line)) {
    return null
  }

  try {
    return JSON.parse(line.toString("utf8"))
  } catch {
    return null
  }
}

// Avoid reading entire journals or retaining a huge JSONL record in memory.
async function* readLines(file, size) {
  const chunk = Buffer.allocUnsafe(HEADER_BYTES)
  const overlapBytes = TRANSFER_MARKER.length - 1
  let record
  let carried = 0
  let oversized = false
  // The caller requests one more bounded header record after a title slot.
  let readingHeader = true
  for (let position = 0; position < size;) {
    const { bytesRead } = await file.read(
      chunk,
      0,
      Math.min(position === 0 ? INITIAL_READ_BYTES : chunk.length, size - position),
      position
    )
    if (bytesRead === 0) return
    position += bytesRead

    const bytes = chunk.subarray(0, bytesRead)
    for (let start = 0; start < bytesRead;) {
      const newline = bytes.indexOf(0x0a, start)
      const end = newline < 0 ? bytesRead : newline
      const segment = bytes.subarray(start, end)
      if (readingHeader && carried + segment.length >= HEADER_BYTES) return

      if (oversized || carried + segment.length > RECORD_BYTES) {
        // An oversized message can be skipped, but not a possible transfer.
        const prefix = record.subarray(0, carried)
        const overlap = Buffer.concat([
          prefix.subarray(-overlapBytes),
          segment.subarray(0, overlapBytes),
        ])
        if (
          (!oversized && prefix.includes(TRANSFER_MARKER)) ||
          overlap.includes(TRANSFER_MARKER) ||
          segment.includes(TRANSFER_MARKER)
        ) {
          yield OPAQUE_TRANSFER
          return
        }
        const tail = segment.length >= overlapBytes ? segment : overlap
        carried = tail.subarray(-overlapBytes).copy(record)
        oversized = true
      } else if (carried > 0 || newline < 0) {
        record ??= Buffer.allocUnsafe(RECORD_BYTES)
        carried += segment.copy(record, carried)
      }

      if (newline >= 0) {
        const line = oversized ? null : carried > 0 ? record.subarray(0, carried) : segment
        readingHeader = (yield line) === true
        carried = 0
        oversized = false
      }
      start = end + 1
    }
  }
  if (carried > 0 && !oversized) yield record.subarray(0, carried)
}

async function findEvidence(lines, url, header, isClaimed) {
  const isLegacy = header.version === undefined || header.version === 1
  let evidence = isClaimed ? CLAIM_EVIDENCE : null
  let latestTransfer
  const calls = new Set()
  let assistantEntryId
  let lastResultEntryId
  for await (const line of lines) {
    if (line === OPAQUE_TRANSFER) {
      return null
    }

    const mayBeTransfer = line?.includes(TRANSFER_MARKER)
    if (!mayBeTransfer) {
      if (evidence) {
        continue
      }

      if (calls.size === 0 && (!line?.includes(ASSISTANT_ROLE) || !line.includes(GITHUB_CLI))) {
        continue
      }
    }
    const entry = parseRecord(line)
    if (!entry) {
      if (mayBeTransfer) {
        return null
      }

      calls.clear()
      continue
    }
    if (mayBeTransfer) {
      const transfer = transferKind(entry)
      if (transfer === "invalid") {
        return null
      }

      if (transfer) latestTransfer = transfer
    }
    if (evidence || entry.type !== "message") {
      continue
    }

    const message = entry.message
    if (message?.role === "assistant") {
      calls.clear()
      assistantEntryId = entry.id
      lastResultEntryId = undefined
      if (typeof assistantEntryId !== "string" && !isLegacy) {
        continue
      }

      if (!Array.isArray(message.content) || ["aborted", "error"].includes(message.stopReason)) {
        continue
      }
      for (const block of message.content) {
        if (
          block?.type === "toolCall" &&
          block.name === "bash" &&
          typeof block.id === "string" &&
          block.id.length > 0 &&
          !block.arguments?.async &&
          !block.arguments?.notify &&
          !block.arguments?.name &&
          isDirectPRCreate(block.arguments?.command)
        ) {
          calls.add(block.id)
        }
      }
    } else if (message?.role === "toolResult") {
      // Version 1 journals lacked entry IDs and are ordered by their records.
      if (
        entry.parentId !== assistantEntryId &&
        (lastResultEntryId === undefined || entry.parentId !== lastResultEntryId)
      ) {
        calls.clear()
        continue
      }
      lastResultEntryId = entry.id
      if (calls.delete(message.toolCallId) && hasSuccessfulPROutput(message, url)) {
        evidence = CREATE_EVIDENCE
      }
    } else {
      calls.clear()
    }
  }
  return latestTransfer === "departed" || latestTransfer === "forked" ? null : evidence
}

// Mirror the structured markers in OMP's session/session-transfer.ts. A stale
// source can cause switchSession to fork, which is not a successful resume.
function transferKind(entry) {
  if (entry.type !== "custom_message" || entry.customType !== "session-transfer") return

  const { details } = entry
  if (
    details?.kind === "arrived" &&
    typeof details.fromCwd === "string" &&
    typeof details.cwd === "string"
  ) {
    return "arrived"
  }
  if (details?.kind === "departed" && typeof details.to === "string") {
    return "departed"
  }

  if (
    details?.kind === "forked" &&
    typeof details.source === "string" &&
    typeof details.to === "string"
  ) {
    return "forked"
  }
  return "invalid"
}

function hasSuccessfulPROutput(message, url) {
  if (message.toolName !== "bash" || message.isError !== false || !Array.isArray(message.content)) {
    return false
  }

  const { details, content } = message
  if (
    (details?.exitCode !== undefined && details.exitCode !== 0) ||
    details?.timedOut ||
    details?.async
  ) {
    return false
  }
  if (content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") {
    return false
  }

  // gh prints the created URL to stdout. The Bash tool merges output, so only
  // admit known diagnostics around that single URL, not arbitrary other text.
  const lines = content[0].text.split(/\r?\n/).filter((line) => line.trim() !== "")
  if (details?.wallTimeNoticeEmitted === true && Number.isFinite(details.wallTimeMs)) {
    const notice = `Wall time: ${(details.wallTimeMs / 1000).toFixed(2)} seconds`
    if (lines.at(-1) === notice) lines.pop()
  }
  if (/^Warning: \d+ uncommitted changes?$/.test(lines[0])) lines.shift()
  const banner = lines[0]?.match(
    /^Creating (?:draft )?pull request for [\w./:-]+ into [\w./-]+ in ([\w.-]+\/[\w.-]+)$/
  )
  if (banner && url.startsWith(`https://github.com/${banner[1].toLowerCase()}/pull/`)) {
    lines.shift()
  }
  return lines.length === 1 && normalizePRResumeURL(lines[0]) === url
}

// Recognize one literal command, not shell syntax capable of printing another
// command's URL or masking a failed create. Nothing here is executed.
function isDirectPRCreate(command) {
  if (typeof command !== "string" || !/^[ \t]*gh[ \t]+pr[ \t]+create(?:[ \t]|$)/.test(command)) {
    return false
  }
  let quote = ""
  let word = ""
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (character === quote) {
      quote = ""
    } else if (quote === "'") {
      word += character
    } else if (character === "\\") {
      const next = command[++index]
      if (next === undefined || (quote === '"' && !'\\$`"\n'.includes(next))) {
        return false
      }

      if (next !== "\n") word += next
    } else if (quote === '"') {
      if (character === "$" || character === "`") {
        return false
      }

      word += character
    } else if (character === "'" || character === '"') {
      quote = character
    } else if (character === " " || character === "\t") {
      if (isNonCreatingFlag(word)) {
        return false
      }

      word = ""
    } else {
      if ("\n\r;&|<>()$`#*?[]{}~".includes(character)) {
        return false
      }

      word += character
    }
  }
  return quote === "" && !isNonCreatingFlag(word)
}

function isNonCreatingFlag(word) {
  return /^(?:--(?:help|web|dry-run)(?:=|$)|-[^-]*[hw])/.test(word)
}
