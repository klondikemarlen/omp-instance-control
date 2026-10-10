# OMP Integration

Own extension registration for main interactive instances, lifecycle request admission, and invoking supported public OMP host APIs.

`index.js` registers `/instances` and a control endpoint only for launcher-managed main TUI instances. It calls public `ctx.shutdown()` after acknowledgement, leaving OMP core to decide settlement, persist the transcript, tear down, and release the terminal.

Linux transport belongs in [`../linux/`](../linux/README.md); wire semantics belong in [`../protocol/`](../protocol/README.md).

`launcher-context.js` validates native `ompi` launch identity and captures the current session/cwd during shutdown. The Linux launcher owns relaunch after successful exit, not OMP settlement. Ambiguous custom flag arity makes controlled restart explicitly unavailable without blocking standard OMP invocation. The one explicit private compatibility dependency reads OMP's parsed extension-flag map at `session_start`, validates its shape, and refuses restart for built-in collisions or missing metadata. No private imports or lifecycle keystroke injection are used. See [host dependency and selected workaround](../CONCEPTS.md#host-api-dependency) and [upstream removal criteria](../README.md#temporary-ownership-and-upstream-removal).
