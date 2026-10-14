import { readdir } from "node:fs/promises"
import path from "node:path"

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export async function listProfileNames(scope) {
  const names = new Set(["default", scope.profile])
  let entries
  try {
    entries = await readdir(path.join(scope.configRoot, "profiles"), { withFileTypes: true })
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }

    return [...names].sort()
  }

  for (const entry of entries) {
    if (entry.isDirectory() && PROFILE_NAME.test(entry.name)) {
      names.add(entry.name)
    }
  }

  return [...names].sort()
}
