# OMP Integration

Own extension registration for main interactive instances, lifecycle request admission, and invoking supported public OMP host APIs.

`index.js` registers `/instances` and a control endpoint only for launcher-managed main TUI instances. It calls public `ctx.shutdown()` after acknowledgement, leaving OMP core to decide settlement, persist the transcript, tear down, and release the terminal.

Linux transport belongs in [`../linux/`](../linux/README.md); wire semantics belong in [`../protocol/`](../protocol/README.md).

`launcher-context.js` validates launch identity and captures the current session/cwd during shutdown. The Linux launcher owns relaunch after successful exit, not OMP settlement. No private imports or lifecycle keystroke injection are used. See [host dependency and selected workaround](../CONCEPTS.md#host-api-dependency).
