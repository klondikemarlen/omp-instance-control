import { createRequest, ProtocolError } from "../protocol/index.js"

const UNREACHABLE_CODES = new Set(["ENOENT", "ECONNREFUSED"])

export async function listInstances(transport) {
  const records = await transport.readRecords()
  return Promise.all(
    records.map(async (record) => {
      try {
        const response = await transport.request(record, createRequest(record.instanceId, "status"))
        if (!response.ok) {
          return {
            record,
            status: "failed",
            error: response.error.message,
            errorCode: response.error.code,
          }
        }
        return { record, status: "online", data: response.data }
      } catch (error) {
        return {
          record,
          status: UNREACHABLE_CODES.has(error.code)
            ? "unreachable"
            : error instanceof ProtocolError
              ? "failed"
              : "unknown",
          error: error.message,
        }
      }
    })
  )
}

export async function restartInstances(transport, { all = false, instanceId } = {}) {
  if (all === Boolean(instanceId)) {
    throw new TypeError("Choose one restart target: an instance ID or all.")
  }

  const records = await transport.readRecords()
  const selected = all ? records : records.filter((record) => record.instanceId === instanceId)

  if (selected.length === 0) {
    return [{ instanceId, status: "failed", error: "No matching instance found." }]
  }

  return Promise.all(
    selected.map(async (record) => {
      try {
        const response = await transport.request(
          record,
          createRequest(record.instanceId, "restart")
        )
        if (!response.ok) {
          return {
            record,
            instanceId: record.instanceId,
            status: "failed",
            error: response.error.message,
            errorCode: response.error.code,
          }
        }
        return {
          record,
          instanceId: record.instanceId,
          status: "accepted",
          data: response.data,
        }
      } catch (error) {
        const status = UNREACHABLE_CODES.has(error.code)
          ? "unreachable"
          : error instanceof ProtocolError
            ? "failed"
            : "unknown"
        return { record, instanceId: record.instanceId, status, error: error.message }
      }
    })
  )
}

function safeText(value) {
  return String(value).replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
}

function compactProjectPath(value) {
  const parts = value.split("/").filter(Boolean)
  if (parts.length <= 2) {
    return value
  }

  return `.../${parts.slice(-2).join("/")}`
}

function errorSummary(row) {
  if (row.status !== "unreachable") {
    return row.error ?? ""
  }

  if (row.error?.includes("connect ENOENT") || row.error?.endsWith("no such file or directory")) {
    return "socket missing"
  }

  if (row.error?.includes("connect ECONNREFUSED") || row.error?.endsWith("connection refused")) {
    return "connection refused"
  }

  return "endpoint unavailable"
}

export function formatRows(rows) {
  return rows
    .map((row) => {
      let id = row.instanceId || row.record?.instanceId || "unknown"
      if (id.length === 32) {
        id = id.slice(0, 12)
      }

      let state = row.status === "online" ? row.data?.state || row.status : row.status
      if (state === "restart-requested") {
        state = "restart pending"
      }

      const currentCwd = row.data?.cwd || row.record?.cwd
      const parts = [id, state]
      if (currentCwd) {
        parts.push(compactProjectPath(currentCwd))
      }

      if (row.status === "online" && row.data?.lastRestart) {
        parts.push("(previous restart completed)")
      }

      const error = errorSummary(row)
      if (error) {
        parts.push(error)
      }

      return parts.map(safeText).join("  ")
    })
    .join("\n")
}
