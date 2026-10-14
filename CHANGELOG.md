# Changelog

## 0.5.2 - 2026-10-14

### Fixed

- Complete configured profile names in spaced and inline `/ompi instances --profile` options, including default listing without an explicit action.
- Keep profile candidates within the active configuration root and preserve action, option, and live instance-ID autocomplete.

## 0.5.1 - 2026-10-14

### Fixed

- Keep Linux takeover file/permission checks, executable discovery, environment handling, and shell command construction in `linux/`; keep public host session capture/revalidation in `omp/`.
- Group the Linux takeover behavior tests under `test/linux/` and align affected test names with the shared verification baseline without changing their assertions.

## 0.5.0 - 2026-10-14

### Added

- `/ompi take-over` prepares a safely quoted manual resume command for a plain-OMP session, shows it in a copy-and-confirm dialog, and requests OMP-owned graceful exit.
- Preserve the exact saved transcript, current working directory, profile, configuration root, default agent-directory override, and runtime scope. Save preparation as session metadata without starting a model turn.
- Refuse missing/empty/ephemeral transcripts, unsafe command values, unavailable native executables, and already wrapped sessions; revalidate after confirmation so a session switch cannot shut down the wrong conversation.

### Limits

- Relaunch requires one manual shell paste after OMP exits. No automatic handoff, process killing, terminal-input injection, or original startup-argument replay.

## 0.4.0 - 2026-10-14

### Changed

- Replace `/instances` with `/ompi instances`, automatically loaded by the Ubuntu wrapper and installable through the public OMP plugin manager for ordinary-OMP peer control.
- Mirror default listing, restart, help/version, and five control options inside and outside OMP: `--all`, `--instance`, `--profile`, `--json`, and `--no-wait`. Remove control-command `--cwd` and `--timeout`; ordinary OMP launch arguments are unchanged.
- Wait for verified peer relaunch with in-OMP progress and cancellable observation. Self-selected snapshots return accepted/pending without waiting on their own shutdown.
- Complete actions/options and full online instance IDs with profile-scoped caches.

### Fixed

- Claim one adapter binding through the public host event bus when installed and injected paths resolve to the same extension; avoid duplicate endpoints and self-wait deadlocks.
- Match Ctrl-C through public in-memory keybindings, including extended terminal encodings, without changing user keybindings.
- Preserve empty and repeated profile-option semantics between native and in-OMP controls.

## 0.3.0 - 2026-10-14

### Changed

- Wait for verified relaunch by default in external `ompi instances restart`, with per-instance terminal progress and transition-only output when redirected.
- Add explicit `--no-wait` acknowledgement-only behavior and optional `--timeout DURATION`; JSON returns final completion results unless `--no-wait` is selected.
- Keep in-session `/instances restart` request-only to avoid waiting on its own shutdown.

### Fixed

- Stop displaying omitted restart-acknowledgement capabilities as `launcher=unmanaged canRestart=false`.
- Treat closing status connections and endpoint gaps as transient restart phases; require matching operation and previous-instance metadata from a live replacement before reporting success.
- Cancel blocked status probes when observation is interrupted. Ctrl-C and timeout leave accepted OMP requests intact.

## 0.2.0 - 2026-10-09

### Changed

- Replace the Node.js launcher with the statically linked Go `ompi` executable. Bare `ompi` launches OMP; standard arguments, subcommands, help/version, and noninteractive invocations pass through.
- Move external instance control to `ompi instances list|restart`; retain the participating instance's `/instances` command. Remove the old npm executable and explicit `launch` interface.
- Package the executable and public-API OMP adapter as a native Ubuntu Resolute package using its own dedicated `ppa:klondikemarlen/omp-instance-control` archive. The executable requires neither Node.js nor a separate plugin installation.
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
