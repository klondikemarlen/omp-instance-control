# Project Guidance

## Scope

This project owns local control of participating OMP instances through the native Go `ompi` wrapper and a host-loaded JavaScript adapter using public lifecycle APIs. Bare `ompi` launches standard OMP; ordinary OMP commands pass through. Same-terminal restart/resume uses OMP's safe settled boundary. Resource-only refresh remains unavailable. Do not add placeholder actions or unobserved installation claims.

Linux is the initial target. macOS and Windows are possible future extensions, not supported platforms.

## Organization

Follow omp-send-context's integration-oriented layout. Keep OMP host integration in `omp/`, shared client behavior in `cli/`, wire contracts in `protocol/`, and Linux-specific transport, filesystem, permissions, and process behavior in `linux/`. Group tests under `test/<integration>/`.

Keep shared code independent of Linux paths. Do not scatter `process.platform` branches or add speculative macOS/Windows adapters. Introduce only the smallest boundary required by real behavior.

## Lifecycle Invariants

- OMP owns settlement, transcript persistence, teardown, and terminal release. The explicitly selected launcher workaround owns relaunch and argument selection after successful exit; do not duplicate OMP's idle predicate.
- Do not equate `turn_end`, `agent_end`, or `ctx.isIdle()` alone with session settlement; background work and queued submissions can still wake the agent.
- Never kill another instance or inject terminal keystrokes to imitate a lifecycle API.
- Use a fresh instance identity per launch. PID alone is not an identity: native POSIX restart can retain the PID.
- Resource refresh does not imply extension-code reload or executable upgrade.
- Preserve profile/config-root boundaries by default. Cross-profile selection must be explicit.
- Track the host dependency in [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458). Do not invent supported host methods or depend on private OMP internals without an explicit design decision.
- The explicit parsed-flag compatibility decision permits only read-only `pi.runtime.flagValues` access at `session_start`. Refuse controlled restart if the map is unavailable or an extension shadows a built-in option used by the launch. Do not register observer flags or extend this exception to other internals; see [Concepts](CONCEPTS.md#parsed-extension-flag-compatibility-decision).

## Delivery Standards

- Create an issue with acceptance criteria before implementation. Record learner coverage; manual project setup does not itself justify a learner issue.
- Use `issue-<number>/<outcome-slug>` branches and linked pull requests. Self-review the complete diff, record focused QA, resolve feedback, and merge using a merge commit.
- Use title case for issue, pull request, and Markdown headings, preserving identifiers and acronyms.
- Commit subjects follow `:emoji: Imperative outcome.` Keep configuration, dependencies, documentation, and unrelated implementation changes in separate commits; run `check-commit-scope` after staging.
- Prefer readable Go for the native command and ES modules for host-loaded adapter code. Keep functions and control flow small; avoid speculative frameworks or service abstractions.
- Keep import groups contiguous with one blank line between groups. Use one blank line between unrelated logical blocks. Prefer `Promise.withResolvers()` for event-based completion.
- Run gofmt, Go behavior checks/vet, Prettier, and `git diff --check`. Keep Go package tests beside the native code they exercise; keep adapter integration tests under `test/<integration>/`. Exercise real isolated multi-instance OMP terminals for lifecycle changes.
- Keep credentials, environment files, sockets, and session/runtime state out of Git. Do not create `.envrc.example`.
- Do not modify configured model routes. Runtime release QA must uninstall the isolated QA installation, install the released artifact, verify its version, then exercise behavior and autocomplete in fresh OMP processes; current processes retain loaded modules.

## Development Checks

```bash
npm ci
npm test
npm run check
npm run build
git diff --check
```
