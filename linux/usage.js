import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"

import { getScope } from "../protocol/index.js"
import { ensurePrivateDirectory } from "./transport.js"

// Keep the counter format and feature names in sync with linux/usage.go.
const FEATURES = new Set([
  "list",
  "restart",
  "send",
  "steer",
  "cleanup",
  "take-over",
  "work.list",
  "work.find",
  "work.resume",
  "work.set",
  "work.clear",
  "restore.select",
  "restore.save",
  "restore.name",
  "restore.slot",
  "restore.list",
  "restore.checkpoint",
  "restore.history",
  "restore.from",
  "restore.export",
])
const COUNTER_INCREMENT = Buffer.alloc(1)
const APPEND_FLAGS =
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK

export async function recordSlashUsage(feature, launchScope) {
  if (process.env.OMPI_USAGE !== "1" || !FEATURES.has(feature)) return

  try {
    const scope = launchScope ?? getScope()
    const uid = process.getuid()
    const directory = path.join(scope.agentDir, "instance-control", "usage-v1")
    await ensurePrivateDirectory(directory)
    const counter = await open(path.join(directory, `slash.${feature}`), APPEND_FLAGS, 0o600)
    try {
      const info = await counter.stat()
      if (info.isFile() && info.uid === uid && (info.mode & 0o077) === 0 && info.nlink === 1) {
        await counter.write(COUNTER_INCREMENT)
      }
    } finally {
      await counter.close()
    }
  } catch {
    // Usage collection must not affect the command or its displayed result.
  }
}
