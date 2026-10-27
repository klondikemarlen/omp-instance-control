# Control Protocol

Own the shared request/response semantics, request identifiers, lifecycle actions, and fresh per-launch instance identity. Keep this contract independent of transport and operating-system paths.

Distinguish request acceptance, busy deferral, action completion, and failure. PID alone cannot identify a launch because native POSIX restart can retain it.

`control.go` and the adapter's `index.js` define interoperable version 1: `{version, instanceId, requestId, action}` requests, with `status`, child-only `restart`, and explicit native `restart-wrapper` actions. Responses match both identities and contain either `{ok: true, data}` or `{ok: false, error: {code, message}}`. Scope includes config root, profile, and effective agent directory, independently of Linux runtime paths. Go scope hashing preserves the JavaScript field order. See [shared concepts](../CONCEPTS.md).

Current user-facing restart commands always send `restart-wrapper`, including scoped ID/prefix and `all` targets. The child-only wire action remains interoperable with older clients, not a fallback when native replacement is unavailable.

Automatic `restart-wrapper` requests may additionally carry `nativeTarget: {device, inode, size, modifiedNs}`. All fields are canonical decimal strings: device/inode/size are unsigned 64-bit values and modifiedNs is a signed 64-bit value. Other actions reject a non-null target. The adapter retains this verified identity through the native handoff; ordinary manual requests omit it.

Received response data is read-only. Native CLI JSON preserves the host payload's explicit nulls, absent capability fields, and unknown fields rather than synthesizing values from Go defaults.

Status data may include `sendContext: {version, protocolVersion}` for the loaded Send Context plugin, or `null` when unverified. Its package version and routing protocol are independent of this control protocol's version, OMP, and the native wrapper. An older response without the field stays absent in JSON and renders as unknown in human-facing lists. Restart admission and completion correlation do not depend on plugin metadata.

Status may also carry `native: {runningVersion, installedVersion, state, message?}`. Installed version is `null` until verified; state distinguishes checking, current, pending, and failed observation/adoption. These are executing-launcher and installed-candidate facts, independent of OMP and Send Context versions. Older payloads remain unchanged in JSON and display native metadata as unknown.

`canRestart` reports persisted-session readiness and availability of the public cooperative APIs. A persistent session may accept a restart while that flag is false because its first response has not materialized the allocated transcript yet. Acceptance does not claim shutdown or completion.

Cooperative status adds `cooperative: {operationId, phase, message?, requestedAt, checkpointAt?, resumedAt?}` to acknowledgement and status data. Phases distinguish preparing, restarting, resuming, resumed and blocked. Observers retain the accepted operation separately, require matching replacement and continuation correlation when this metadata exists, and fail on a correlated blocker. `resumed` means continuation was invoked, not that agent work finished. Older peers without the field keep their original completion rules; JSON preserves absent and unknown fields.

Recovery contracts describe persistent managed snapshots, optional name bindings, checkpoint membership, and review-only legacy entries. A checkpoint records which slots belonged to a recovery set; a slot's latest safe snapshot remains authoritative. Legacy entries have no managed owner and cannot be treated as launchable slots. Platform implementations validate private storage and process identities; CLI and host consumers preserve unavailable states rather than falling back to an older conversation.
