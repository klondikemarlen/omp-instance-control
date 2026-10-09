import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

export const PROTOCOL_VERSION = 1

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "ProtocolError"
    this.code = code
  }
}

export function getScope({ env = process.env, profile, cwd = process.cwd() } = {}) {
  const selectedProfile = profile ?? env.OMP_PROFILE ?? env.PI_PROFILE ?? "default"
  const normalizedProfile = selectedProfile.trim() || "default"
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalizedProfile)) {
    throw new ProtocolError("INVALID_PROFILE", "Profile names cannot contain paths or whitespace.")
  }

  const home = env.HOME || homedir()
  const configRoot = path.resolve(home, env.PI_CONFIG_DIR || ".omp")
  const agentDir =
    normalizedProfile === "default"
      ? path.resolve(cwd, env.PI_CODING_AGENT_DIR || path.join(configRoot, "agent"))
      : path.join(configRoot, "profiles", normalizedProfile, "agent")
  const scope = { configRoot, profile: normalizedProfile, agentDir }
  const id = createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 16)
  return { id, ...scope }
}

export function validateInstanceId(instanceId) {
  if (typeof instanceId !== "string" || !/^[a-f0-9]{32}$/.test(instanceId)) {
    throw new ProtocolError("INVALID_INSTANCE", "Expected a complete per-launch instance ID.")
  }
  return instanceId
}

export function createRequest(instanceId, action, requestId = randomUUID()) {
  return validateRequest({ version: PROTOCOL_VERSION, instanceId, requestId, action })
}

export function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("INVALID_REQUEST", "Expected a control request object.")
  }
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError("UNSUPPORTED_VERSION", "Unsupported control protocol version.")
  }
  validateInstanceId(value.instanceId)
  if (
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > 128
  ) {
    throw new ProtocolError("INVALID_REQUEST", "Expected a bounded nonempty request identifier.")
  }
  if (value.action !== "status" && value.action !== "restart") {
    throw new ProtocolError(
      "UNSUPPORTED_ACTION",
      "Only status and restart are supported; resource-only reload is unavailable."
    )
  }
  return value
}

export function validateResponse(value, request) {
  if (!value || typeof value !== "object" || value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError("INVALID_RESPONSE", "Invalid control response or protocol version.")
  }
  if (value.instanceId !== request.instanceId || value.requestId !== request.requestId) {
    throw new ProtocolError(
      "WRONG_INSTANCE",
      "Control response does not match the requested launch and operation."
    )
  }
  if (value.ok !== true && value.ok !== false) {
    throw new ProtocolError("INVALID_RESPONSE", "Control response must declare success or failure.")
  }
  if (value.ok && (!value.data || typeof value.data !== "object" || Array.isArray(value.data))) {
    throw new ProtocolError(
      "INVALID_RESPONSE",
      "Successful control response lacks structured data."
    )
  }
  if (
    !value.ok &&
    (typeof value.error?.code !== "string" || typeof value.error?.message !== "string")
  ) {
    throw new ProtocolError(
      "INVALID_RESPONSE",
      "Failed control response lacks an error code and message."
    )
  }
  return value
}
