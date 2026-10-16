# Linux Platform

Linux is the initial target. This directory owns Unix socket transport, private runtime-directory discovery, filesystem ownership and permissions, and Linux-specific process handling.

Use private same-user local IPC rather than a public TCP listener. Do not use process signals to force a restart or treat a PID as a stable launch identity.

`transport.go` provides native client transport and private filesystem helpers; `transport.js` remains the OMP adapter's bounded Unix-socket server. `launcher.go` inherits terminal streams, validates and consumes a one-shot restart handoff after successful child exit, and resumes the current session/cwd without replaying initial messages. Signals cancel relaunch and forward only to the owning child. Native launch-argument rewriting is temporary until OMP provides the supported host restart request.

`registration.go` removes a reaped child's registrations using private per-identity handoffs bound to its launcher token, scope, and actual child PID. It reuses the transport's runtime-directory rules, verifies record contents and socket identity before removal, and preserves changed or unsafe artifacts. A failed connection alone never triggers cleanup; legacy records without ownership handoffs remain visible.

`stale.go` and the explicit `transport.js` cleanup operation retire legacy records only after positive process absence (`ESRCH`) and a missing/refused endpoint. They recheck private ownership, scope, record bytes, and socket identity before deletion, preserve live/reused or uncertain PIDs, and continue independent records after per-record failures. This is an operator action, not discovery or installation behavior.

`take-over.js` accepts a plain session-file/cwd snapshot and owns Linux filesystem/permission checks, executable discovery, scope resolution, and the quoted POSIX resume command. It does not receive OMP host contexts or invoke UI/lifecycle methods. Its behavior tests live in `test/linux/`; host session capture and revalidation remain in `omp/`.

`profiles.js` enumerates valid named-profile directories within one configuration root for cached OMP autocomplete. It includes `default` and the selected profile without creating directories or probing other profiles' control endpoints.

`bash-completion/ompi` owns Linux Bash command/option completion and is installed at `/usr/share/bash-completion/completions/ompi` by the Ubuntu package. It keeps instance-control candidates local and delegates ordinary OMP completion to the installed executable's public `completions bash` command without launching an interactive session or dispatching instance actions. Loading that catalog restores the prior `omp` completion registration (including its absence); shared startup files and unrelated registrations are not managed.

Keep shared request semantics in [`../protocol/`](../protocol/README.md) and OMP host integration in [`../omp/`](../omp/README.md). Future macOS or Windows implementations belong in separate platform directories; none is supported or implemented now.
