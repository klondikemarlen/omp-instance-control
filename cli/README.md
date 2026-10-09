# External Client

Own instance selection, explicit profile/config-root scope, request dispatch, and truthful per-instance outcome reporting. Another OMP instance should use the same client behavior rather than a second broadcast implementation.

`client.js` receives a platform transport and selects a snapshot, never future replacement instances. It reports accepted, failed, unreachable, and unknown outcomes without automatic replay; status includes the replacement's completed-operation metadata. Linux socket paths do not belong in shared client behavior.

`index.js` is the Node CLI composition root: it parses `launch` and `instances` commands with the standard library and wires the current Linux implementation. See [usage](../README.md#usage) and [shared concepts](../CONCEPTS.md).
