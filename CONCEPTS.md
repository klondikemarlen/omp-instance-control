# Concepts

## Purpose

Give an operator or another OMP instance a local, explicit way to request restart or plugin resource refresh from participating terminal instances without interrupting active work.

## Ownership

| Boundary                                                                | Owner       |
| ----------------------------------------------------------------------- | ----------- |
| Instance selection and broadcast outcomes                               | `cli/`      |
| Request identifiers, actions, responses, and launch identity            | `protocol/` |
| Linux socket endpoints, permissions, and discovery records              | `linux/`    |
| Extension registration and invoking supported host actions              | `omp/`      |
| Settlement, teardown, terminal handoff, persistence, and restart/resume | OMP core    |

A control endpoint belongs to a running main interactive instance, not a task subagent or persisted transcript. A restart produces a fresh launch identity even when the PID remains unchanged.

## Safe Lifecycle Boundary

An accepted request is not a completed action. A busy instance defers the action until OMP's settlement predicate allows it. A single tool/model turn ending is insufficient: admitted submissions, queued prompts, async jobs, and pending deliveries can still wake the session.

Broadcasts select a snapshot of reachable instances. Newly launched replacement instances must not replay the old request. Scope discovery by profile/config root by default; broader selection must be explicit.

## Reload Versus Restart

Resource refresh rediscoveries and MCP reconnects are different from re-evaluating an extension module or replacing the OMP executable. Do not report a process upgrade or code reload after a resource-only refresh.

Restart should reuse native OMP teardown and relaunch behavior. Only persisted conversations can be resumed; ephemeral or never-materialized sessions need an explicit policy before implementation.

## Host API Dependency

The existing upstream feature request is [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458).

Observed on OMP 18.8.7 during the setup investigation:

- A throwaway extension exposed private Unix sockets in two isolated interactive instances. An external client queried both and requested graceful shutdown; both exited with code 0.
- Native `/restart` loaded edited extension code while preserving the persisted session ID and terminal. On Linux, it retained the PID through process-image replacement.
- Native `/reload-plugins` retained the already-imported extension module.
- Deferred restart while real work was active was not exercised.

Source contracts:

- [Public extension context](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/extensibility/extensions/types.ts): shutdown is exposed; restart and plugin-refresh requests are not. Command-context reload is a session operation.
- [Interactive lifecycle](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/modes/interactive-mode.ts): native restart and the settled shutdown-request path.
- [Plugin refresh](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/slash-commands/builtin-marketplace.ts): discovery and MCP refresh.
- [Session reload](https://github.com/can1357/oh-my-pi/blob/v18.8.7/packages/coding-agent/src/session/agent-session.ts): reopens the session transcript.

The preferred integration needs public host lifecycle requests callable from extension callbacks and scheduled by OMP at settlement. API names and availability remain unresolved; no private-import, terminal-injection, or launch-wrapper workaround has been selected.

## Platform Scope

Linux is the initial implementation target. Linux transport and discovery stay in `linux/`; protocol semantics and OMP lifecycle ownership remain platform-independent. Future macOS or Windows support adds its own platform directory and focused behavior checks without making the shared client or protocol depend on Linux-specific paths.
