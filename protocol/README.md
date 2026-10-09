# Control Protocol

Own the shared request/response semantics, request identifiers, lifecycle actions, and fresh per-launch instance identity. Keep this contract independent of transport and operating-system paths.

Distinguish request acceptance, busy deferral, action completion, and failure. PID alone cannot identify a launch because native POSIX restart can retain it.

No wire schema or fixtures are defined yet; derive them from the first real implementation and its consumer-visible behavior. See [shared concepts](../CONCEPTS.md).
