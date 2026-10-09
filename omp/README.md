# OMP Integration

Own extension registration for main interactive instances, lifecycle request admission, and invoking supported public OMP host APIs.

OMP core owns the settled-boundary decision, teardown, terminal handoff, launch-argument rewriting, persistence, and same-terminal restart/resume. Do not implement those operations through private imports or terminal keystroke injection.

Linux transport belongs in [`../linux/`](../linux/README.md); wire semantics belong in [`../protocol/`](../protocol/README.md).

No extension entry point exists yet. See [host dependency and observed evidence](../CONCEPTS.md#host-api-dependency).
