# Linux Platform

Linux is the initial target. This directory owns Unix socket transport, private runtime-directory discovery, filesystem ownership and permissions, and Linux-specific process handling.

Use private same-user local IPC rather than a public TCP listener. Do not use process signals to force a restart or treat a PID as a stable launch identity.

`transport.js` owns validated private directories/records, bounded newline-framed Unix sockets, and scope-local discovery. `launcher.js` inherits terminal streams, validates and consumes a one-shot restart handoff after successful child exit, and resumes the current session/cwd without replaying initial messages. Signals cancel relaunch and forward only to the owning child.

Keep shared request semantics in [`../protocol/`](../protocol/README.md) and OMP host integration in [`../omp/`](../omp/README.md). Future macOS or Windows implementations belong in separate platform directories; none is supported or implemented now.
