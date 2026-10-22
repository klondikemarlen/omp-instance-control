import { createRequest } from "../protocol/index.js"

export async function requestWrapperRestart(runtime) {
  if (!runtime) {
    throw new Error(
      "This OMP session is not managed by ompi. Start a fresh OMP session from an ompi launcher before using /ompi restart."
    )
  }
  if (runtime.launch?.canRestartWrapper !== true) {
    throw new Error(
      "This ompi launcher does not support restarting its native wrapper. Start a fresh OMP session from an updated ompi launcher before using /ompi restart."
    )
  }
  if (
    typeof runtime.instanceId !== "string" ||
    !runtime.launch.scope?.id ||
    typeof runtime.transport?.readRecords !== "function"
  ) {
    throw new Error(
      "Could not resolve this managed OMP instance. Start a fresh OMP session from an ompi launcher and retry."
    )
  }

  const records = await runtime.transport.readRecords()
  const record = records.find(
    (candidate) =>
      candidate.instanceId === runtime.instanceId && candidate.scope === runtime.launch.scope.id
  )
  if (!record) {
    throw new Error(
      "Could not find this managed OMP instance in its launch scope. Start a fresh OMP session from an ompi launcher and retry."
    )
  }

  const request = createRequest(runtime.instanceId, "restart-wrapper")
  const response = await runtime.transport.request(record, request)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  if (response.data.state !== "accepted" || typeof response.data.operationId !== "string") {
    throw new Error("The managed OMP instance returned an invalid restart acknowledgement.")
  }
}
