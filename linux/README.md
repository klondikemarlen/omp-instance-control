# Linux Platform

Linux is the initial target. This directory owns Unix socket transport, private runtime-directory discovery, filesystem ownership and permissions, and Linux-specific process handling.

Use private same-user local IPC rather than a public TCP listener. Do not use process signals to force a restart or treat a PID as a stable launch identity.

Keep shared request semantics in [`../protocol/`](../protocol/README.md) and OMP host integration in [`../omp/`](../omp/README.md). Future macOS or Windows implementations belong in separate platform directories; none is supported or implemented now.
