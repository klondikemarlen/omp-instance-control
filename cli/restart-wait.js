import { setTimeout as sleep } from "node:timers/promises"

import { createRequest } from "../protocol/index.js"

const RESTART_POLL_INTERVAL_MS = 250
const INSTANCE_DISAPPEARING_CODES = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EOF",
])

// Progress rows are borrowed synchronously. Callbacks must not retain or mutate
// rows or the raw response data they reference.
export async function waitForRestarts(transport, rows, { signal, onProgress } = {}) {
  const currentRows = rows.map((row) => ({ ...row }))
  for (const row of currentRows) {
    if (row.status === "accepted") {
      prepareAcceptedRestart(row)
    }
  }

  notifyProgress(onProgress, currentRows)
  throwIfAborted(signal)
  if (!hasPendingRestart(currentRows)) {
    return currentRows
  }

  while (hasPendingRestart(currentRows)) {
    throwIfAborted(signal)

    let records
    try {
      records = await transport.readRecords()
    } catch (error) {
      throwIfAborted(signal)
      for (const row of currentRows) {
        if (isPendingRestart(row)) {
          setRestartUnknown(row, `read replacement instances: ${error.message}`)
        }
      }
      notifyProgress(onProgress, currentRows)
      return currentRows
    }

    throwIfAborted(signal)
    const snapshot = indexRestartRecords(records)
    let changed = false

    for (let index = 0; index < currentRows.length; index += 1) {
      if (!isPendingRestart(currentRows[index])) {
        continue
      }

      const before = currentRows[index]
      const updated = { ...before }
      try {
        await observeRestart(transport, updated, snapshot, signal)
      } catch (error) {
        if (restartRowChanged(before, updated)) {
          currentRows[index] = updated
          changed = true
        }

        if (changed) {
          notifyProgress(onProgress, currentRows)
        }

        throw error
      }

      if (restartRowChanged(before, updated)) {
        currentRows[index] = updated
        changed = true
      }

      if (signal?.aborted) {
        if (changed) {
          notifyProgress(onProgress, currentRows)
        }

        throw signal.reason
      }
    }

    if (changed) {
      notifyProgress(onProgress, currentRows)
    }

    throwIfAborted(signal)

    if (!hasPendingRestart(currentRows)) {
      return currentRows
    }

    await waitForNextPoll(signal)
  }

  return currentRows
}

function prepareAcceptedRestart(row) {
  if (typeof row.instanceId !== "string" || row.instanceId.length === 0) {
    row.instanceId = row.record?.instanceId ?? ""
  }

  const operationId = row.data?.operationId
  if (typeof operationId !== "string" || operationId.length === 0) {
    setRestartUnknown(row, "restart acknowledgement did not include an operation ID")
    return
  }

  if (
    !row.instanceId ||
    row.record?.instanceId !== row.instanceId ||
    !Number.isSafeInteger(row.record?.pid) ||
    row.record.pid <= 0
  ) {
    setRestartUnknown(row, "restart result did not retain the original instance record")
    return
  }

  row.status = "waiting"
}

function hasPendingRestart(rows) {
  return rows.some(isPendingRestart)
}

function isPendingRestart(row) {
  return row.status === "waiting" || row.status === "restarting"
}

function indexRestartRecords(records) {
  const byInstanceId = new Map()
  const replacementsByOperation = new Map()

  for (const record of records) {
    byInstanceId.set(record.instanceId, record)
    const lastRestart = record.lastRestart
    if (!lastRestart) {
      continue
    }

    let byPreviousInstance = replacementsByOperation.get(lastRestart.operationId)
    if (!byPreviousInstance) {
      byPreviousInstance = new Map()
      replacementsByOperation.set(lastRestart.operationId, byPreviousInstance)
    }

    let replacements = byPreviousInstance.get(lastRestart.previousInstanceId)
    if (!replacements) {
      replacements = []
      byPreviousInstance.set(lastRestart.previousInstanceId, replacements)
    }

    replacements.push(record)
  }

  return { byInstanceId, replacementsByOperation }
}

async function observeRestart(transport, row, snapshot, signal) {
  const operationId = row.data.operationId
  const originalRecord = snapshot.byInstanceId.get(row.instanceId)
  row.status = originalRecord ? "waiting" : "restarting"

  const candidates = snapshot.replacementsByOperation.get(operationId)?.get(row.instanceId) ?? []
  let candidateError

  for (const candidate of candidates) {
    if (!isRestartCandidate(candidate, row.instanceId, operationId)) {
      continue
    }

    let response
    try {
      response = await requestStatus(transport, candidate, signal)
    } catch (error) {
      throwIfAborted(signal)
      if (isInstanceDisappearing(error)) {
        continue
      }

      candidateError = new Error(`probe replacement ${candidate.instanceId}: ${error.message}`)
      continue
    }

    throwIfAborted(signal)

    if (!response.ok) {
      if (response.error?.code === "INSTANCE_CLOSING") {
        continue
      }

      candidateError = new Error(
        `probe replacement ${candidate.instanceId}: ${responseError(response)}`
      )
      continue
    }

    if (!liveReplacementMatches(response.data, candidate, row.instanceId, operationId)) {
      candidateError = new Error(
        `probe replacement ${candidate.instanceId}: live status did not match its discovered restart record`
      )
      continue
    }

    row.status = "restarted"
    row.data = response.data
    delete row.error
    delete row.errorCode
    return row
  }

  if (candidateError) {
    setRestartUnknown(row, candidateError.message)
    return row
  }

  if (!originalRecord) {
    row.status = "restarting"
    return row
  }

  let response
  try {
    response = await requestStatus(transport, originalRecord, signal)
  } catch (error) {
    throwIfAborted(signal)
    if (isInstanceDisappearing(error)) {
      row.status = "restarting"
      return row
    }

    setRestartUnknown(row, `probe original instance: ${error.message}`)
    return row
  }

  throwIfAborted(signal)

  if (!response.ok) {
    if (response.error?.code === "INSTANCE_CLOSING") {
      row.status = "restarting"
      return row
    }

    setRestartUnknown(row, `probe original instance: ${responseError(response)}`)
    return row
  }

  if (!response.data || response.data.instanceId !== row.instanceId) {
    setRestartUnknown(row, "probe original instance: status did not match the original identity")
    return row
  }

  row.status = "waiting"
  return row
}

function isRestartCandidate(candidate, originalInstanceId, operationId) {
  if (candidate.instanceId === originalInstanceId) {
    return false
  }

  if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) {
    return false
  }

  return (
    candidate.lastRestart?.operationId === operationId &&
    candidate.lastRestart?.previousInstanceId === originalInstanceId
  )
}

function liveReplacementMatches(data, candidate, originalInstanceId, operationId) {
  if (
    !data ||
    data.instanceId !== candidate.instanceId ||
    data.pid !== candidate.pid ||
    candidate.instanceId === originalInstanceId ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0
  ) {
    return false
  }

  return (
    data.lastRestart?.operationId === operationId &&
    data.lastRestart?.previousInstanceId === originalInstanceId
  )
}

function requestStatus(transport, record, signal) {
  return transport.request(record, createRequest(record.instanceId, "status"), { signal })
}

function responseError(response) {
  if (response.error?.message) {
    return response.error.message
  }

  if (response.error?.code) {
    return response.error.code
  }

  return "status request was rejected without an error"
}

function isInstanceDisappearing(error) {
  return INSTANCE_DISAPPEARING_CODES.has(error?.code)
}

function setRestartUnknown(row, message) {
  row.status = "unknown"
  row.error = message
  delete row.errorCode
}

function restartRowChanged(before, after) {
  return (
    before.status !== after.status ||
    before.error !== after.error ||
    before.errorCode !== after.errorCode ||
    before.data !== after.data
  )
}

function notifyProgress(onProgress, rows) {
  if (onProgress) {
    onProgress(rows)
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason
  }
}

async function waitForNextPoll(signal) {
  try {
    await sleep(RESTART_POLL_INTERVAL_MS, undefined, { signal })
  } catch (error) {
    throwIfAborted(signal)

    throw error
  }
}
