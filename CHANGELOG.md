# Changelog

## 0.2.0 - 2026-10-09

### Changed

- Replace the Node.js launcher with the statically linked Go `ompi` executable. Bare `ompi` launches OMP; standard arguments, subcommands, help/version, and noninteractive invocations pass through.
- Move external instance control to `ompi instances list|restart`; retain the participating instance's `/instances` command. Remove the old npm executable and explicit `launch` interface.
- Package the executable and public-API OMP adapter as a native Ubuntu Resolute package using the existing `ppa:klondikemarlen/omp-send-context` archive. The executable requires neither Node.js nor a separate plugin installation.
- Document per-feature ownership and removal criteria as supported OMP lifecycle and instance-control APIs arrive upstream.

### Safety

- Preserve current-session/cwd resume, fresh launch identities, profile/config-root boundaries, duplicate-request coalescing, and truthful request outcomes across the native cutover.
- Refuse controlled restart when extension flag arity is ambiguous or an extension shadows a built-in option used by the launch; the original OMP invocation still passes through.
- Check parsed extension-flag metadata through one documented read-only private OMP compatibility boundary. Missing metadata fails closed; lifecycle actions remain on public APIs.
- Retain literal flag-valued strings during restart path normalization and apply the protocol's UTF-16 identifier bound to restart handoffs.
- Preserve nullable and absent response fields in native CLI JSON rather than synthesizing capabilities.
- Keep generated adapter/resume arguments unshadowable, use the child's process cwd for relaunch, and refuse incomplete or ambiguously flag-shaped spaced string values.
- Preserve reserved management-command rejection across profile bootstrap.

## 0.1.1 - 2026-10-09

### Fixed

- Run the installed CLI through npm bin symlinks instead of silently returning without executing a command.

## 0.1.0 - 2026-10-09

### Added

- Linux/Ubuntu launcher that requests OMP-owned graceful shutdown and resumes the current persisted session in the same terminal after successful exit.
- Profile/config-root-scoped private Unix-socket discovery, per-launch identities, one-target restart, and explicit snapshot broadcast.
- Shared external CLI and `/instances` commands with accepted, failed, unreachable, unknown, and completed-after-relaunch metadata.
- One-shot validated handoffs, duplicate-request coalescing, and launch-configuration retention without replaying the initial prompt.
- Ordered metadata writes and shutdown admission guards so late agent events cannot recreate removed endpoints.
- Safe discovery during concurrent instance exits, unknown outcomes for invalid acknowledgements, literal startup-message boundaries, and retained relative agent-directory overrides.
- Deterministic protocol, filesystem, transport, selection, launcher, and teardown-race behavior checks.

### Limits

- Participating terminals must use the launcher; unwrapped or non-persisted sessions cannot restart/resume through this helper.
- Resource-only reload, automatic package upgrades, macOS, and Windows are not implemented.
- OMP 18.8.7 is the initial verification target; the upstream host lifecycle request remains tracked in [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458).
