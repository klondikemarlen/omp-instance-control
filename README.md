# OMP Instance Control

`ompi` layers instance control on top of standard `omp`. Bare `ompi` launches OMP in the current terminal; normal OMP arguments and subcommands pass through. The additional `instances` command group discovers participating terminals and requests settled-boundary restart/resume.

OMP owns settlement, transcript persistence, and graceful teardown. The native Go wrapper reopens the current persisted conversation in the same terminal after successful shutdown.

## Requirements

- Linux and an independently installed `omp` on `PATH`.
- An interactive terminal for participating sessions; a persisted session for restart/resume.
- OMP 18.8.7 is the initial verification target. Lifecycle actions use public extension APIs; one read-only private flag-metadata boundary is documented below.

The `ompi` executable is statically linked and does not require Node.js. OMP loads the shipped JavaScript adapter using its own runtime. macOS and Windows are not supported. Resource-only reload and automatic package/executable upgrades are not implemented.

## Installation

The Ubuntu 26.04 (Resolute) package uses its own dedicated `ppa:klondikemarlen/omp-instance-control` archive. Install after the package has been published:

```bash
sudo add-apt-repository ppa:klondikemarlen/omp-instance-control
sudo apt update
sudo apt install omp-instance-control
ompi instances --version
```

The package installs `/usr/bin/ompi` and the plugin under `/usr/share/omp-instance-control/`. `ompi` loads it automatically; no separate plugin installation is required for wrapped sessions. Existing processes retain their loaded modules; launch fresh processes after installation or upgrade.

The apt package includes Bash completion at `/usr/share/bash-completion/completions/ompi` and depends on `bash-completion`. Open a fresh interactive Bash shell after installation; no completion setup command or shell-configuration edit is required when the standard Ubuntu Bash completion startup is enabled. Tab completes `ompi instances r` to `ompi instances restart`, lists `list`, `restart`, and `cleanup` after `ompi instances `, and offers action-specific flags. Profile names and instance IDs remain free-form values. Ordinary OMP commands and launch options reuse the installed OMP's generated completion, loaded on first use.

Completion owns only the `ompi` registration. Lazy OMP delegation preserves an existing `omp` completion handler, and the package does not edit shared Bash startup or completion files. If an already-open shell cached a fallback before installation, run `source /usr/share/bash-completion/bash_completion` followed by `complete -r ompi 2>/dev/null`, or open a fresh shell.

The old npm launcher and `omp-instance-control launch` interface are replaced, not aliased. If previously installed globally through npm, remove that old package with `npm uninstall --global omp-instance-control`. Installing only the adapter cannot add instance control to ordinary unwrapped sessions.

To use `/ompi instances` from ordinary `omp`, install the controller through OMP's public plugin manager:

```bash
omp plugin install github:klondikemarlen/omp-instance-control
omp plugin list
```

Start a fresh OMP process afterward. This adds peer controls, not an endpoint or automatic self-restart capability to an unwrapped process. To move its saved conversation under the wrapper, use `/ompi take-over` below. Restartable sessions still launch with `ompi`. Installing the plugin alongside the wrapper does not register duplicate commands or endpoints.

## Usage

Use `ompi` like `omp`:

```bash
ompi
ompi --cwd /path/to/project
ompi --profile work --resume SESSION_ID
ompi --model MODEL --thinking high "Review this change"
ompi --help
ompi --version
ompi plugin list
```

Standard help/version, subcommands, and noninteractive modes retain OMP behavior. `ompi --version` reports the installed OMP version; `ompi instances --version` reports the wrapper version. Interactive launch loads the adapter unless extensions are explicitly disabled.

From another terminal:

```bash
ompi instances list
ompi instances
ompi instances restart --instance FULL_INSTANCE_ID
ompi instances restart --all
ompi instances list --profile work --json
ompi instances cleanup
ompi instances --help
```

External restart waits until every accepted target has a verified live replacement. Each pending target has an animated loader; the header shows elapsed time, restarted/pending counts, and issues. Rows update in place with semantic colors, safely shortened paths, and a pending-first viewport when the terminal is too small. Resizing and Unicode paths do not disable live progress. `NO_COLOR` disables colors, not animation; redirected output and `TERM=dumb` log plain state transitions without cursor controls.

Long project paths shorten from the left to retain the project-name ending; duplicate working directories show a short session suffix. Failed restart rows retain the original project/session record, including in JSON. Pending guidance means OMP has not yet shut down; active turns, queued submissions, and background work can defer settlement. The helper cannot identify the exact host-side blocker from the public lifecycle API and does not impose a deadline or force shutdown. Unreachable records get an explicit cleanup command, not automatic removal.

Human-facing lists show short display IDs, current state, the final two project-path components, concise connection failures, and a small annotation for a previous completed restart. These display IDs are not abbreviated selectors: use `--json` or in-OMP Tab completion for full IDs. JSON retains full paths, restart correlation, and raw diagnostics. Partial-failure warnings distinguish unreachable registrations from reachable instances.

Use `ompi instances restart --all --no-wait` for acknowledgement-only behavior. Waiting is unlimited by default. Ctrl-C stops watching and exits with status 130; it does not cancel accepted requests or kill OMP. `--json` waits too and prints only the final result array; combine it with `--no-wait` when scripts need immediate acceptance.

From OMP with the plugin loaded:

```text
/ompi instances
/ompi instances list --json
/ompi instances restart --instance FULL_INSTANCE_ID
/ompi instances restart --all
/ompi instances list --profile work
/ompi instances cleanup
/ompi instances --help
/ompi instances --version
```

Both surfaces expose `list`, `restart`, and `cleanup`, with five control options: `--all`, `--instance ID`, `--profile NAME`, `--json`, and `--no-wait`. `instances` defaults to listing; restart requires an explicit selector. Cleanup accepts only `--profile` and `--json` (plus help/version). Control-command `--cwd` and `--timeout` are removed; standard OMP launch arguments, including `--cwd`, are unchanged.

Inside OMP, peer restart waits with animated, themed progress, elapsed time, and Ctrl-C cancellation. A selection containing the invoking wrapped session returns accepted/pending immediately for the entire snapshot: waiting for its own relaunch would prevent shutdown. `--no-wait` works on both surfaces. Use it when invoking the external command as an OMP tool in a selected session.

Argument autocomplete covers the namespace, actions, options, configured profile names, and full online instance IDs. Profile values complete in both `--profile NAME` and `--profile=NAME` forms, including default listing without an explicit `list` action. Suggestions include `default` and the active profile and stay inside the current configuration root. ID suggestions are cached per profile/config-root scope and refreshed at startup, after listing or observed peer relaunch, and on session lifecycle events. List the selected profile first to refresh its IDs. The former `/instances` command is removed, not aliased.

`--all` selects a snapshot in the current profile/config-root scope. Replacement instances do not receive the old request. Select another profile explicitly with control-command `--profile`; use the same `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and `XDG_RUNTIME_DIR` as the participating launchers. Named profiles ignore `PI_CODING_AGENT_DIR`, as OMP does.

Run `ompi instances cleanup` (or `/ompi instances cleanup`) to retire old registrations in the selected scope. It requires both a positively absent recorded PID and a missing/refused endpoint, then rechecks private file contents and socket identity before removal. JSON reports each full `instanceId`, `status` (`removed`, `preserved`, or `failed`), and `reason`; native cleanup exits nonzero on failures while still cleaning independent eligible records. Live or reused PIDs, uncertain owners, reachable endpoints, changed files, and socket-only files without records are preserved. Listing and autocomplete remain read-only. Cleanup sends no shutdown/restart requests, and installation never deletes runtime state.

Use `--` before flag-shaped initial messages. Initial messages and startup session actions are never replayed after a controlled restart. For custom string-valued extension flags, use `--custom=value`; for custom boolean flags before a message, separate the message with `--`. An unknown bare flag followed by a non-flag token, a missing string value, or a flag-looking spaced string value makes controlled restart unavailable. Use `--system-prompt=--literal` for a flag-shaped string value. Initial OMP invocation still passes through unchanged.

The wrapper does not register or shadow OMP flags. A parsed extension value sharing a built-in option used by the launch makes controlled restart unavailable rather than guessing its parsing or changing the original invocation. Ordinary spaced options such as `--model MODEL` remain supported.

### Taking Over a Plain-OMP Session

With the plugin loaded in ordinary `omp` and the native `ompi` executable on `PATH`, run:

```text
/ompi take-over
```

Copy the shell command from the dialog, then confirm graceful exit. After OMP has exited and your shell prompt returns, paste that command once in the same terminal. It resumes the exact saved session under `ompi`, preserving its current working directory, profile, config root, default-profile agent-directory override, and runtime-directory scope.

The command is a snapshot of the session you selected; do not switch sessions while waiting for exit. Preparation is saved in session metadata without starting a model turn. Cancelling the dialog or changing sessions before confirmation leaves OMP running. Missing, empty, or ephemeral session files, an unavailable `ompi`, and control characters in command values are refused before shutdown. Already wrapped sessions use `/ompi instances restart` instead.

OMP owns settlement, transcript persistence, teardown, and terminal release. There is no automatic takeover, process killing, terminal-input injection, or replay of original startup arguments. The manual paste is required because plain OMP has no wrapper parent to relaunch it.

### Recovering Sessions After Reboot

Managed `ompi` sessions are captured automatically once their transcript exists. No restore name is required. Recovery checkpoints retain the active managed slots outside the runtime directory; the default menu prefers the latest checkpoint from a previous boot, otherwise the latest current-boot checkpoint.

After your terminal restores its Bash tabs, run this in each tab:

```bash
ompi restore
```

Select a slot and confirm its exact session ID and working directory. `ompi restore --list` lists candidates; add `--json` for structured output. Use `--slot FULL_SLOT_ID` to select directly and `--profile work` explicitly for another OMP profile. Recovery runs only in the terminal where you invoke it; it does not open terminal windows or modify shell startup.

Optional names remain available:

```text
/ompi restore save payments-main
```

From another terminal, use `ompi restore save payments-main --instance FULL_INSTANCE_ID`. Names use up to 64 letters, digits, dots, underscores, or hyphens, starting with a letter or digit; `save` is reserved. `ompi restore payments-main` selects that slot directly. A name stays bound to its evolving wrapper slot, not to its original project directory or a frozen transcript bookmark. Saving an existing name again is refused.

`ompi restore --checkpoint` saves a manual membership checkpoint. `--history` lists retained checkpoints; `--from CHECKPOINT_ID` restricts selection to that checkpoint. A checkpoint freezes membership, not transcript contents: each slot follows its latest safely captured session and cwd through switches, branches, and controlled restarts. A normal exit removes the closing slot from active membership, including when the resulting checkpoint is empty. The newest ten checkpoints are retained, plus the newest previous-boot checkpoint when it falls outside that set, for at most eleven.

Private state lives under the selected agent directory at `instance-control/restore/`, outside `XDG_RUNTIME_DIR`. Exact transcript paths and safe launch options are retained without copying transcripts or replaying startup prompts. Missing or not-yet-written transcripts stay quietly unavailable and invalidate predecessor snapshots; recovery never silently opens an older conversation. Unsafe paths, a live launcher or OMP child, uncertain ownership, or a concurrent restore holding the slot lock refuse launch.

Recovery requires trusted ancestors that are not group- or world-writable. If an ordinary launch cannot prepare that store safely, it reports recovery as unavailable and continues without a recoverable slot; standard OMP invocation and existing restart eligibility are unchanged. Correct only the reported owned directory's permissions, then start a fresh launcher. For example, `chmod go-w ~/.omp` removes group/other write access from an owned, group-writable OMP config root; the wrapper never changes those permissions for you.

`/ompi restore` provides the same recovery operations inside OMP. Selection displays a quoted shell command before confirmation and graceful exit: copy it, wait for your shell, then paste it. No nested OMP terminal is started. Both command surfaces complete optional saved names and recovery options.

Ptyxis restores layout, profile, and cwd, but does not supply a durable per-tab identity or save custom command argv in its [50.1 session format](https://sources.debian.org/data/main/p/ptyxis/50.1-1/src/ptyxis-session.c). This explicit menu does not change Ptyxis profiles or Bash startup. Verification covers real Ptyxis close/reopen on an isolated headless display and loss of the isolated runtime directory, not an OS reboot of the workstation.

Start a fresh `ompi` launcher after upgrading: launchers started before 0.9.0 cannot supply restore metadata merely by restarting their OMP child. Resume the existing session under the new launcher before naming its slot.

### Migrating Legacy Recovery Snapshots

`ompi restore --import-legacy` imports the old helper's `~/.local/state/omp-session-resume-helper/snapshots/*.txt` and `active-sessions.txt`, leaving the originals untouched. Supply a path to import one snapshot. Only the helper's strictly quoted command format is parsed; shell text is never evaluated. Transcript IDs must resolve uniquely to an owned file within the selected profile's session tree. Unsupported, missing, or ambiguous entries are reported.

Imports appear in `ompi restore --history` as legacy checkpoints, not default automatic recovery. They cannot acquire invented managed-slot ownership or launch automatically. Inspect one with `ompi restore --list --from CHECKPOINT_ID` and export manual commands with:

```bash
ompi restore --export --from CHECKPOINT_ID
```

Managed exports use `ompi restore --slot` and retain ownership checks; legacy exports are explicitly unowned manual resume commands. Both preserve the selected config root, profile, and effective agent directory while using the terminal's current runtime directory, not a stored path from a previous boot.

Version 0.10.1 also recognizes OMP's [256-byte title slot](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md#file-format) before the session header. If 0.10.0 reported existing transcripts as missing, re-import their legacy source after upgrading; the corrected import does not overwrite older immutable checkpoints. Re-importing a source already retained by the same reader revision reuses its checkpoint. Pruned imports can be recreated and remain subject to the bounded history policy.

## Outcomes and Safety

- `accepted` means one restart operation is retained, not that restart completed. A fresh persistent session waits for its first saved response before graceful shutdown is requested; an allocated transcript path is not yet a resumable file. Truly ephemeral sessions are refused. Active turns, queued submissions, and background jobs remain OMP's responsibility. A stuck or never-materialized session stays pending; the helper never kills it or fabricates a transcript.
- A replacement's `lastRestart` identifies the completed operation and previous instance. Every boot has a fresh instance identity, independent of PID or transcript ID.
- External CLI and in-OMP peer progress distinguish `waiting` for the first saved response or OMP settlement, `restarting` through endpoint transitions, and `restarted` after a live replacement confirms both the operation ID and previous instance ID. Disappearance or a PID change alone never proves completion; closing status connections are transient, not failures.
- `failed` reports explicit rejection, including an ephemeral session, invalid transcript path, or no matching target. `unreachable` means a missing/refused endpoint; `unknown` means acknowledgement was inconclusive. Requests are never automatically replayed.
- Normal `/exit`, unsuccessful child exit, and termination signals do not relaunch. Handoffs are validated and consumed once after successful child exit.
- Relaunch resumes the actual current session file and cwd, not the original selector. Original configuration paths and relative default-profile agent-directory overrides remain anchored across directory changes.
- Restart admission checks OMP's private parsed extension-flag map read-only at `session_start`. Missing metadata or a parsed built-in collision refuses restart before shutdown. This map is not a registry: unused no-default flags may be absent. Generated restart uses the unshadowable `-r` alias and the child's process cwd, not injectable long options. The explicit compatibility dependency was verified on OMP 18.8.7 and audited on 18.12.2; it does not mutate flags or replace public lifecycle APIs.
- Private same-user Unix sockets and discovery records live under `$XDG_RUNTIME_DIR/omp-instance-control`, or `/tmp/omp-instance-control-<uid>` when unset. Unsafe permissions, symlinks, and overlong socket paths fail explicitly.
- Before publishing an endpoint, the adapter writes a private token-bound ownership handoff. After reaping its child, the wrapper removes only that launch's unchanged registration/socket, including after abnormal child exit. It preserves mismatched identities and unsafe files. Explicit `instances cleanup` can retire legacy registrations or records left by a crashed wrapper only when owner absence and endpoint failure are both confirmed; connection failure or PID reuse alone is not enough. Same-user IPC is not a sandbox against other programs running as your account.

## Temporary Ownership and Upstream Removal

Track [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458). Keep this wrapper additive; remove functionality when OMP supplies the corresponding supported contract:

| Current Wrapper Responsibility                                       | Removal Criterion                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Foreground relaunch, one-shot handoff, and launch-argument rewriting | Public settled-boundary restart/resume request API owns persistence, terminal handoff, and argument rewriting.         |
| JavaScript shutdown/handoff adapter                                  | Supported host lifecycle and instance-control APIs replace its public extension callbacks.                             |
| Read-only parsed extension-flag compatibility guard                  | Supported parsed-flag metadata is exposed, or OMP owns restart argument selection.                                     |
| Scoped instance discovery, Unix sockets, and request dispatch        | OMP exposes supported same-user discovery/control preserving profile/config-root boundaries and per-launch identities. |
| The `ompi` executable/package                                        | Standard `omp` supplies all required instance-control commands; migrate usage and remove the redundant wrapper.        |

The [OMP 18.12.2 compatibility audit](CONCEPTS.md#host-api-dependency) found no fully satisfied removal criterion. Keep the current boundaries until supported public APIs cover the same behavior; OMP's internal native restart is not an extension or peer-control contract.

Resource refresh is not loaded-extension re-evaluation or executable upgrade. Do not replace public host contracts with private imports, terminal injection, or PID-based lifecycle guesses. See [Concepts](CONCEPTS.md) and [Changelog](CHANGELOG.md).

## Repository Layout

- `omp/`: public OMP adapter and handoff binding.
- `cli/`: native entry point and shared selection/outcomes; adapter-required JavaScript client.
- `protocol/`: shared scoped identities and wire contracts, independent of Linux paths.
- `linux/`: native foreground launcher/client transport and adapter-required JavaScript server.
- Native `*_test.go` files: package-level behavior and private-boundary checks.
- `test/<integration>/`: adapter integration behavior tests.
- `debian/`: native Ubuntu package; no OMP executable or user configuration bundled.

## Development and Release

Install Go 1.25+ and Node.js 22+ for development:

```bash
npm ci
npm run build
npm test
npm run format
npm run check
git diff --check
./dist/ompi instances --help
```

`make build` produces `dist/ompi` without cgo or runtime dependencies. The installed wrapper resolves its adapter relative to the real executable, not the working directory.

Follow issue-named branches, linked PRs, complete self-review, focused QA, and merge commits. Create or verify the dedicated public [OMP Instance Control PPA](https://launchpad.net/~klondikemarlen/+archive/ubuntu/omp-instance-control) before uploading. Do not reuse another project's archive.

Development commands require Ruby and the `marlens-skills-rules-and-tools` OMP plugin installed under `~/.omp/plugins/`. Run `./bin/dev sign` directly from the checkout; `./dev` is a directory containing the project plugin, not an executable. To use the shorter `dev sign`, add `PATH_add bin` to an ignored local `.envrc`, then run `direnv allow`. Your shell must have the direnv hook enabled; otherwise use `./bin/dev`.

From a clean, committed release checkout, `dev package` prepares an unsigned source upload using only tracked files. `dev package binary` builds a local binary package. Both keep outputs under ignored `build/debian/` and remove their temporary staging tree after the build. Existing artifacts are never overwritten; keep them or increment `debian/changelog` before preparing another build.

Run `dev sign` in your terminal to sign the current prepared upload. It selects the source/version from `debian/changelog`, sets `GPG_TTY`, and uses `debsign`'s normal maintainer-key selection. Install the helper once with `sudo apt install --no-install-recommends devscripts` if needed. Enter the existing key's passphrase locally; signing neither rebuilds nor uploads, and an already signed upload is left unchanged.

```bash
dev package
dev sign
dput ssh-ppa:klondikemarlen/omp-instance-control build/debian/omp-instance-control_0.10.1~ppa1_source.changes
```

SFTP uses your local username unless a `dput` login is configured; set it to your Launchpad account when the names differ.

Wait for Launchpad's Resolute/amd64 build and public package index before claiming publication. Download the released package, uninstall the isolated QA installation, reinstall that artifact, verify its installed version, and exercise standard commands, restart/resume, and `/ompi instances` autocomplete in fresh isolated OMP processes. Also uninstall/reinstall the public GitHub plugin and verify its version and ordinary-OMP peer controls in a fresh process. System installation additionally requires authorized apt access; isolated-root QA is not a system-install claim.

Runtime QA uses isolated homes/config roots and real terminals. Verify current session/cwd, fresh module loading, profile isolation, duplicate-request coalescing, normal exit, and settlement with queued prompts/background delivery. Do not change the operator's configured models, credentials, or plugins during QA.
