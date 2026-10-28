# Changelog

## 0.18.0 - 2026-10-28

### Changed

- Notify about installed updates without restarting terminals automatically; choose the current terminal, one peer, or an explicit scoped `all` when ready.
- Let OMP finish active work and queued typed prompts before restart, then reopen the saved conversation for input without model-generated checkpoint, preparation or continuation messages.
- Preserve accepted native-image identity while waiting for shutdown; refuse a later binary replacement rather than silently changing the pending operation.

## 0.17.2 - 2026-10-28

### Changed

- Shorten active-session restart instructions and ask for a brief actionable checkpoint; retain the saved checkpoint in the continuation and keep idle restarts message-free.
- Keep the installed native version and update-accepted notification without the settlement jargon. Acceptance still does not mean restart has completed.

## 0.17.1 - 2026-10-28

### Fixed

- Restart idle managed terminals without starting preparation or continuation model turns, including when a provider is unavailable. Active and queued work retains cooperative checkpointing and OMP-owned settlement.

## 0.17.0 - 2026-10-27

### Added

- Ask active agents to pause and checkpoint unfinished work before a safe restart, then submit one correlated continuation in the resumed conversation without repeating completed effects.
- Show cooperative preparation, restart, continuation and concrete blocked outcomes in native and in-OMP controls. Report missing checkpoints after about a minute without forcing shutdown.
- Require stable OMP 18.13.2 or newer for non-interrupting cooperative delivery; preserve normal launch and peer controls on older hosts. Ambiguous continuation admission blocks rather than automatically sending again.

## 0.16.0 - 2026-10-27

### Added

- Detect installed native `ompi` replacements automatically in capable managed terminals and adopt them through OMP-owned settled restart, preserving the conversation, working directory, profile and recovery slot.
- Show each instance's running native version, installed version and update state in native and in-OMP lists.
- Refuse missing, unusable or changed replacement images explicitly, with bounded version checks and no automatic relaunch loop.

## 0.15.0 - 2026-10-26

### Added

- Show each online instance's loaded Send Context version and routing protocol in `ompi control list` and `/ompi list`, with structured metadata under `data.sendContext` in JSON.
- Keep missing, stale, unsafe, or older plugin metadata explicitly unknown. Version queries neither change context routing nor expose private bridge tokens.

## 0.14.0 - 2026-10-23

### Changed

- Replace the native `ompi` wrapper as well as OMP for every restart target, including explicit IDs/prefixes and `all` on both command surfaces. After installing an update, one scoped batch can adopt the installed wrapper while preserving each conversation, cwd, profile and recovery slot.
- Refuse unsupported launchers before shutdown instead of silently restarting only OMP; supported peers in the same batch still restart independently.

## 0.13.0 - 2026-10-23

### Added

- Restart a terminal using the short instance ID shown in its OMP status line or an instance list: `ompi control restart PREFIX` and `/ompi restart PREFIX` accept unique lowercase hexadecimal prefixes within the selected profile/config scope.
- Refuse ambiguous prefixes without restarting any instance; use a longer prefix or full ID to select the intended terminal. Restart requests and completion observation continue using full identities.

## 0.12.0 - 2026-10-22

### Changed

- Keep Bash controller commands under `ompi control …`, leaving ordinary OMP commands and launch options untouched outside that namespace.
- Use flat `/ompi list`, `/ompi restart [ID|all]`, and `/ompi cleanup` commands inside OMP. An omitted restart target selects only the current managed terminal; Bash requires an explicit target.
- Discover controller usage through `help [COMMAND]` and `version`, with contextual actions, restart targets, and saved names rather than repeated metadata flags.
- Migrate managed restore commands to `ompi control restore`; command preparation requires native 0.12.0 or newer. Old controller command spellings and restart selector flags are removed rather than aliased.

### Fixed

- Show advanced completion options only after typing `-`, omit already-used options and conflicting recovery operations, and keep option-value positions free of unrelated flag menus.

## 0.11.0 - 2026-10-22

### Added

- Restart the current managed terminal with `/ompi restart`, replacing the installed native wrapper and reloading OMP while preserving its exact conversation, working directory, configuration, and recovery slot.
- Offer `restart` directly in `/ompi` completion and explain when an older launcher needs a fresh launch before native replacement is available.

## 0.10.1 - 2026-10-21

### Fixed

- Resolve legacy recovery IDs from OMP transcripts whose session header follows a fixed-width title slot, without scanning conversation contents or weakening filesystem checks.
- Re-import snapshots previously read by 0.10.0 to repair false missing-transcript results while preserving older immutable checkpoints.

## 0.10.0 - 2026-10-21

### Added

- Automatically capture recovery membership for managed `ompi` sessions without requiring a name for every terminal.
- Select managed slots in existing terminals, with optional names, bounded checkpoint history, prior-boot preservation, and explicit profile scope.
- Import legacy Resume Helper snapshots as strictly parsed review-only data, preserving originals and exporting scope-anchored manual commands without evaluating shell text.
- Mirror recovery history, checkpoint, import, export, and slot selection on the native and in-OMP command surfaces.

### Fixed

- Recheck the confirmed session snapshot under the restore lock so recovery cannot silently launch a changed conversation.
- Preserve quiet pending capture for not-yet-written transcripts while retaining explicit unsafe-path and ownership failures.
- Keep concurrent checkpoint publication and pruning readable instead of reporting transient missing-file failures.
- Anchor cross-profile selection and portable recovery commands to the selected scope while using the current terminal runtime directory.

## 0.9.3 - 2026-10-20

### Fixed

- Wait quietly for OMP to create a new session's transcript before capturing its restore snapshot, including at startup and graceful exit.
- Keep missing-transcript slots unavailable and invalidate predecessor snapshots without weakening explicit restore or unsafe-path checks.

## 0.9.2 - 2026-10-20

### Changed

- Let a matching explicit OMP exit intent suppress a pending controlled-restart handoff; OMP still owns graceful settlement and teardown.

## 0.9.1 - 2026-10-19

### Fixed

- Retain a fresh persistent session's restart request while its first response has not yet materialized a transcript, then request OMP-owned settled shutdown without replaying the request or startup prompt.
- Explain first-response persistence waits in external and in-OMP restart progress; continue refusing ephemeral sessions and invalid transcript paths.

## 0.9.0 - 2026-10-19

### Added

- Save named wrapper slots and restore their current exact session and working directory from an explicit shell menu after terminal recreation.
- Mirror named save/list/restore preparation inside OMP, with profile-scoped saved-name completion on both command surfaces.
- Keep private recovery snapshots outside runtime discovery state; refuse live launcher/OMP ownership and concurrent restores without moving transcripts or replaying startup prompts.

### Documentation

- Audit OMP 18.12.2 public lifecycle and extension-flag contracts; retain the wrapper responsibilities whose supported upstream replacements remain unavailable.

## 0.8.1 - 2026-10-16

### Fixed

- Preserve existing `omp` Bash completion registrations when lazy-loading its command catalog; keep the package-owned `ompi` completion in the standard autoload directory.
- Retain project/session context on failed restart requests in both clients.
- Keep long project-name endings and repeated-directory session identities visible in native restart progress; explain safe settlement waits and explicit stale-record cleanup without changing lifecycle ownership.

## 0.8.0 - 2026-10-15

### Added

- Ship Bash completion in the Ubuntu package at `/usr/share/bash-completion/completions/ompi`, with the standard completion framework as a package dependency.
- Discover instance-control actions and their supported flags with Tab; preserve ordinary OMP command and launch-option completion by reusing the installed OMP-generated catalog.

## 0.7.0 - 2026-10-15

### Added

- Explicit `ompi instances cleanup` and `/ompi instances cleanup` retire legacy registrations only after positive owner absence and missing/refused endpoint checks, with private file and unchanged-identity safeguards.
- Report per-record removed, preserved, and failed outcomes; support existing profile/JSON options and fresh OMP action/profile autocomplete without adding control flags.

### Safety

- Preserve live/reused PIDs, uncertain owners, responsive endpoints, unsafe or changed files, and socket-only artifacts. Discovery stays read-only; package installation does not sweep runtime state.

### Development

- Align transport and cleanup command regressions with the shared test naming and Arrange/Act/Assert baseline.

## 0.6.0 - 2026-10-15

### Added

- Animate each pending restart with semantic colors, elapsed time, outcome counts, and an explicit settlement/cancellation explanation.
- Keep terminal progress live through resize and long Unicode paths; prioritize pending targets and disclose hidden rows when the snapshot exceeds the viewport. Honor `NO_COLOR` without disabling animation.
- Remove only a reaped child's token-bound, unchanged registrations and sockets, including after abnormal exit and across native same-PID restarts.

### Changed

- Compact CLI and OMP listings to short display IDs, current states, project-path tails, and concise connection failures. Keep full identifiers, paths, history, and raw errors in JSON.
- Explain partial failures without implying that reachable instances failed. Preserve nonzero failure exits, read-only discovery, and plain transition-only redirected output.

## 0.5.3 - 2026-10-14

### Added

- `dev sign` selects and signs the current prepared source upload with the existing maintainer key and local GPG prompting, without rebuilding, uploading, or forcing new signatures.
- `dev package` prepares tracked-only source uploads; `dev package binary` builds local binary packages. Outputs stay under ignored `build/debian/`, temporary staging is removed, and existing artifacts cannot be overwritten.

### Fixed

- Provide a repository-local `./bin/dev` entrypoint so development commands work outside OMP's injected PATH; local direnv setup can expose it as `dev`.

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
