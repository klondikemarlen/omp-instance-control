# Control Protocol

Own the shared request/response semantics, request identifiers, lifecycle actions, and fresh per-launch instance identity. Keep this contract independent of transport and operating-system paths.

Distinguish request acceptance, busy deferral, action completion, and failure. PID alone cannot identify a launch because native POSIX restart can retain it.

`control.go` and the adapter's `index.js` define interoperable version 1: `{version, instanceId, requestId, action}` requests, with `status`, child-only `restart`, explicit native `restart-wrapper`, and `send` actions. Responses match both identities and contain either `{ok: true, data}` or `{ok: false, error: {code, message}}`. Scope includes config root, profile, and effective agent directory, independently of Linux runtime paths. Go scope hashing preserves the JavaScript field order. See [shared concepts](../CONCEPTS.md).

Current user-facing restart commands always send `restart-wrapper`, including scoped ID/prefix and `all` targets. The child-only wire action remains interoperable with older clients, not a fallback when native replacement is unavailable.

`restart-wrapper` requests may carry `nativeTarget: {device, inode, size, modifiedNs}`. All fields are canonical decimal strings: device/inode/size are unsigned 64-bit values and modifiedNs is a signed 64-bit value. Other actions reject a non-null target. When omitted, the adapter captures the installed identity at admission; it retains the accepted identity through duplicate requests and the native handoff. Update observation never dispatches this action.

Received response data is read-only. Native CLI JSON preserves the host payload's explicit nulls, absent capability fields, and unknown fields rather than synthesizing values from Go defaults.

Status data may include `sendContext: {version, protocolVersion}` for the loaded Send Context plugin, or `null` when unverified. Its package version and routing protocol are independent of this control protocol's version, OMP, and the native wrapper. An older response without the field stays absent in JSON and renders as unknown in human-facing lists. Restart admission and completion correlation do not depend on plugin metadata.

Status may also carry `native: {runningVersion, installedVersion, state, message?}`. Installed version is `null` until verified; state distinguishes checking, current, available, and failed observation. `available` means notification only, not accepted restart or applied update. These are executing-launcher and installed-candidate facts, independent of OMP and Send Context versions. Older payloads remain unchanged in JSON and display native metadata as unknown.

`canRestart` reports persisted-session readiness and availability of public session/graceful-shutdown APIs. A persistent session may accept a restart while that flag is false because its first response has not materialized the allocated transcript yet. Acceptance does not claim shutdown or completion.

Acknowledgements retain an `operationId`; observers preserve it separately and require live replacement metadata matching that operation and the original instance. OMP owns settlement of active and queued work, and the replacement reopens the saved conversation for input. Restart adds no checkpoint entries or continuation prompts. Received JSON still preserves absent and unknown fields.

`send` requires `message: {text, delivery}` with nonempty text up to 16 KiB in UTF-8 and delivery `followUp` or `steer`. Other actions reject a message payload. The 128 KiB transport frame bound accommodates worst-case JSON escaping of accepted text plus the request envelope. A target is always one full current launch identity on the wire; clients may resolve one unique prefix in their scoped snapshot, never `all` or an automatically selected replacement.

The adapter hands a visibly marked agent-attributed custom message to public OMP `sendMessage` with `triggerTurn: true`. OMP owns busy follow-up/steering behavior and idle turn activation. Status reports `canSend` independently of restart persistence/readiness. Successful acknowledgement data is `{state: "submitted", messageId: requestId, delivery}`: submission is not durable receipt, processing, a reply, or task completion. Lost acknowledgements remain unknown and are never automatically replayed. An older receiver rejects the new action. The channel does not authenticate an originating agent identity or turn peer text into user authorization.

Recovery contracts describe persistent managed snapshots, optional name bindings, checkpoint membership, and review-only legacy entries. A checkpoint records which slots belonged to a recovery set; a slot's latest safe snapshot remains authoritative. Legacy entries have no managed owner and cannot be treated as launchable slots. Platform implementations validate private storage and process identities; CLI and host consumers preserve unavailable states rather than falling back to an older conversation.
