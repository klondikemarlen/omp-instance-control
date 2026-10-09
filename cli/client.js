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
    throw new TypeError("Choose exactly one of --all or --instance <id>.")
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
            instanceId: record.instanceId,
            status: "failed",
            error: response.error.message,
            errorCode: response.error.code,
          }
        }
        return { instanceId: record.instanceId, status: "accepted", data: response.data }
      } catch (error) {
        const status = UNREACHABLE_CODES.has(error.code)
          ? "unreachable"
          : error instanceof ProtocolError
            ? "failed"
            : "unknown"
        return { instanceId: record.instanceId, status, error: error.message }
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

export function formatRows(rows) {
  return rows
    .map((row) => {
      const record = row.record
      const id = row.instanceId ?? record?.instanceId ?? "unknown"
      const status = row.status
      const details = row.error ?? row.data?.message ?? row.data?.state ?? ""
      const currentCwd = row.data?.cwd ?? record?.cwd
      const cwd = currentCwd ? ` ${safeText(currentCwd)}` : ""
      const restart = row.data?.lastRestart
        ? ` completed-after-relaunch:${safeText(row.data.lastRestart.operationId)}:${safeText(row.data.lastRestart.previousInstanceId)}`
        : ""
      const lifecycle = row.data
        ? ` launcher=${row.data.launcherManaged ? "managed" : "unmanaged"} canRestart=${row.data.canRestart === true}`
        : ""
      return `${safeText(id)}\t${safeText(status)}${cwd}${lifecycle}${restart}${details ? `\t${safeText(details)}` : ""}`
    })
    .join("\n")
}
