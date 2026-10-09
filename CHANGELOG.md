# Changelog

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
