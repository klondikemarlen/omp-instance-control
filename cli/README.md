# External Client

Own instance selection, explicit profile/config-root scope, request dispatch, and truthful per-instance outcome reporting. Another OMP instance should use the same client behavior rather than a second broadcast implementation.

`client.go` and the adapter's `client.js` select a snapshot through a platform transport, never future replacement instances. They report accepted, failed, unreachable, and unknown outcomes without automatic replay; status includes the replacement's completed-operation metadata. Linux socket paths do not belong in shared client behavior.

`restart_wait.go` observes accepted operations with read-only status requests and verifies a live replacement against both the original instance ID and accepted operation ID. Connection-close and missing-endpoint transitions remain pending; cancellation stops only observation. Shared transport requests accept a context so blocked probes can be cancelled without waiting for their socket deadline.

`cmd/ompi/restart.go` owns external CLI waiting, JSON/no-wait output, signals, and optional deadlines. `cmd/ompi/progress.go` owns bounded terminal rendering and append-only fallback. The OMP adapter keeps request-only behavior so it cannot deadlock its own restart. No TUI framework or new runtime dependency is required.

`cmd/ompi/main.go` composes the native command. Bare `ompi` launches OMP; standard commands pass through, while `ompi instances` owns the additive control interface. See [usage](../README.md#usage) and [shared concepts](../CONCEPTS.md).
