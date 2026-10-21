# External Client

Own instance selection, explicit profile/config-root scope, request dispatch, and truthful per-instance outcome reporting. Another OMP instance should use the same client behavior rather than a second broadcast implementation.

`client.go` and the adapter's `client.js` select a snapshot through a platform transport, never future replacement instances. They report accepted, failed, unreachable, and unknown outcomes without automatic replay; status includes the replacement's completed-operation metadata. Linux socket paths do not belong in shared client behavior.

`restart_wait.go` and `restart-wait.js` observe accepted operations with read-only status requests and verify a live replacement against both the original instance ID and accepted operation ID. Connection-close and missing-endpoint transitions remain pending; cancellation stops only observation. Native requests accept a context; JavaScript requests accept an AbortSignal so blocked probes can be cancelled without waiting for their socket deadline.

`cmd/ompi/restart.go` owns external CLI waiting, JSON/no-wait output, and signals. `cmd/ompi/progress.go` owns animated, colored, bounded terminal rendering, resize handling, and plain transition output for redirection or `TERM=dumb`. Pending targets take priority when the viewport cannot show the whole snapshot. The renderer caches derived text rather than retaining borrowed progress rows. The OMP command waits for peers but returns acceptance for self-selected snapshots so it cannot deadlock its own restart. Both surfaces default to listing, require explicit restart selection, and expose only five control options. No TUI framework or new runtime dependency is required.

`cmd/ompi/main.go` composes the native command. Bare `ompi` launches OMP; standard commands pass through, while `ompi instances` owns the additive control interface. See [usage](../README.md#usage) and [shared concepts](../CONCEPTS.md).

Recovery adds an explicit shell menu for automatically captured managed slots, optional immutable names, checkpoint history, and reviewed imports/exports. The CLI confirms the selected exact session; persistent validation, process identity, and per-slot locking remain in `linux/`. Options and completion mirror the host command without automatic shell startup or terminal launching. Legacy data remains review/export-only because it has no verified managed ownership.

`cmd/ompi/cleanup.go` renders explicit Linux cleanup outcomes with full JSON identities/reasons and nonzero failure exits. The native and OMP commands invoke their platform transport's cleanup operation; shared listing and restart clients remain read-only apart from explicit restart dispatch.
