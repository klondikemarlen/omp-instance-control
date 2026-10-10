# External Client

Own instance selection, explicit profile/config-root scope, request dispatch, and truthful per-instance outcome reporting. Another OMP instance should use the same client behavior rather than a second broadcast implementation.

`client.go` and the adapter's `client.js` select a snapshot through a platform transport, never future replacement instances. They report accepted, failed, unreachable, and unknown outcomes without automatic replay; status includes the replacement's completed-operation metadata. Linux socket paths do not belong in shared client behavior.

`cmd/ompi/main.go` composes the native command. Bare `ompi` launches OMP; standard commands pass through, while `ompi instances` owns the additive control interface. See [usage](../README.md#usage) and [shared concepts](../CONCEPTS.md).
