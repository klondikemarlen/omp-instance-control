# Control Protocol

Own the shared request/response semantics, request identifiers, lifecycle actions, and fresh per-launch instance identity. Keep this contract independent of transport and operating-system paths.

Distinguish request acceptance, busy deferral, action completion, and failure. PID alone cannot identify a launch because native POSIX restart can retain it.

`control.go` and the adapter's `index.js` define interoperable version 1: `{version, instanceId, requestId, action}` requests, with `status`, child-only `restart`, and explicit native `restart-wrapper` actions. Responses match both identities and contain either `{ok: true, data}` or `{ok: false, error: {code, message}}`. Scope includes config root, profile, and effective agent directory, independently of Linux runtime paths. Go scope hashing preserves the JavaScript field order. See [shared concepts](../CONCEPTS.md).

Received response data is read-only. Native CLI JSON preserves the host payload's explicit nulls, absent capability fields, and unknown fields rather than synthesizing values from Go defaults.

`canRestart` reports current persisted-session readiness. A persistent session may accept a restart while that flag is false because its first response has not materialized the allocated transcript yet. The operation remains `restart-requested` while waiting for persistence and OMP settlement; acceptance does not claim shutdown or completion.

Recovery contracts describe persistent managed snapshots, optional name bindings, checkpoint membership, and review-only legacy entries. A checkpoint records which slots belonged to a recovery set; a slot's latest safe snapshot remains authoritative. Legacy entries have no managed owner and cannot be treated as launchable slots. Platform implementations validate private storage and process identities; CLI and host consumers preserve unavailable states rather than falling back to an older conversation.
