# Concepts

## Purpose

Give an operator or another OMP instance an explicit way to request safe restart/resume across participating Linux terminals without interrupting their work.

## Ownership

| Boundary                                                              | Owner       |
| --------------------------------------------------------------------- | ----------- |
| Target selection, snapshot broadcasts, and outcomes                   | `cli/`      |
| Profile/config scope, launch identity, and wire validation            | `protocol/` |
| Private discovery records, Unix sockets, and foreground relaunch      | `linux/`    |
| Public extension registration, shutdown requests, and handoff capture | `omp/`      |
| Settlement, transcript persistence, teardown, and terminal release    | OMP core    |

A control endpoint belongs to a main interactive launch, not a subagent or persisted transcript. Instance identity changes on every boot, including native POSIX restart that can retain the PID. A launcher token binds a handoff to one child launch; it is not a network credential.

## Settled Restart Handoff

1. The client reads a profile/config-root-scoped snapshot and sends one request per selected instance.
2. The extension requires a live launcher and an existing persisted session. Concurrent requests coalesce into one operation.
3. After acknowledgement flush, the extension calls public `ctx.shutdown()` once. It does not poll `ctx.isIdle()` or equate `agent_end` with settlement.
4. OMP waits for its settled boundary, including queued submissions and background deliveries. During `session_shutdown`, the extension synchronously captures the current session file and cwd in a private atomic handoff, then removes its endpoint.
5. After successful child exit, the launcher validates and consumes the handoff once. It relaunches with inherited terminal streams, retained configuration, and the current absolute session file; it strips the original messages and old selector.
6. A fresh mounted endpoint exposes `lastRestart.operationId` and `lastRestart.previousInstanceId`. Acceptance is not completion.

Normal exit without a handoff does not restart. Nonzero child exit and launcher termination signals prevent relaunch. A native OMP `/restart` can replace the child in-place; its new plugin binding clears a same-token handoff so a later `/exit` cannot replay it.

A request accepted before a manual graceful exit may be satisfied by that exit. A request whose acknowledgement is lost has an unknown outcome; clients never retry automatically. Stale records are reported as unreachable rather than pruning state based on PID guesses.

## Scope and Trust

Scope includes OMP config root, normalized profile, and effective agent directory. Default-profile `PI_CODING_AGENT_DIR` overrides remain distinct; named profiles ignore that override, as OMP does. The Linux transport chooses its own private runtime path. Shared client code receives a transport object and never constructs Linux socket paths.

Directories are private, owned by the current user, and have trusted non-writable ancestors. Records and sockets are private. Symlink paths and unsafe permissions are rejected. These controls protect against other Unix users, not processes already running under the same account.

## Reload Versus Restart

Resource discovery/MCP reconnects are not extension-module reload or executable upgrade. OMP 18.8.7's `/reload-plugins` retained an edited extension module in the original isolated investigation; native `/restart` loaded it anew while preserving the session and terminal.

This helper implements restart only. It loads code/configuration present on disk at the next launch, without performing package installation or executable upgrades. Unwrapped, ephemeral, or never-materialized sessions cannot claim restart/resume through the helper.

## Host API Dependency

Track [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458). OMP 18.8.7 exposes graceful extension shutdown, but not public restart/plugin-refresh request methods. The user selected a Linux launcher workaround instead of patching OMP.

Public source contracts:

- [Extension context](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/extensibility/extensions/types.ts): `shutdown()` and read-only session access; command-context `reload()` is a session operation.
- [Interactive lifecycle](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/modes/interactive-mode.ts): settled shutdown-request path, native restart, and terminal teardown.
- [Plugin refresh](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/slash-commands/builtin-marketplace.ts): discovery/MCP refresh, not loaded-module re-evaluation.

The launcher does not duplicate OMP's settlement predicate, abort tools, kill sibling instances, inject lifecycle keystrokes, or import private OMP internals.

## Platform Scope

Linux, including Ubuntu, is the only supported platform. Future macOS/Windows implementations must introduce their own concrete platform boundary and focused checks; no speculative adapters or scattered shared-code platform branches are included.
