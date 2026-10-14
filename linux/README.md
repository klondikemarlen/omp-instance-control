# Linux Platform

Linux is the initial target. This directory owns Unix socket transport, private runtime-directory discovery, filesystem ownership and permissions, and Linux-specific process handling.

Use private same-user local IPC rather than a public TCP listener. Do not use process signals to force a restart or treat a PID as a stable launch identity.

`transport.go` provides native client transport and private filesystem helpers; `transport.js` remains the OMP adapter's bounded Unix-socket server. `launcher.go` inherits terminal streams, validates and consumes a one-shot restart handoff after successful child exit, and resumes the current session/cwd without replaying initial messages. Signals cancel relaunch and forward only to the owning child. Native launch-argument rewriting is temporary until OMP provides the supported host restart request.

`take-over.js` accepts a plain session-file/cwd snapshot and owns Linux filesystem/permission checks, executable discovery, scope resolution, and the quoted POSIX resume command. It does not receive OMP host contexts or invoke UI/lifecycle methods. Its behavior tests live in `test/linux/`; host session capture and revalidation remain in `omp/`.

Keep shared request semantics in [`../protocol/`](../protocol/README.md) and OMP host integration in [`../omp/`](../omp/README.md). Future macOS or Windows implementations belong in separate platform directories; none is supported or implemented now.
