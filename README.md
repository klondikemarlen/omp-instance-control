# OMP Instance Control

`ompi` layers instance control on top of standard `omp`. Bare `ompi` launches OMP in the current terminal; normal OMP arguments and subcommands pass through. The reserved `control` namespace discovers participating terminals, sends explicit peer messages, and requests settled-boundary restart/resume. Inside OMP, `/ompi` exposes controller commands directly without the extra namespace.

OMP owns settlement, transcript persistence, and graceful teardown. The native Go wrapper reopens the current persisted conversation in the same terminal after successful shutdown.

## Requirements

- Linux and an independently installed `omp` on `PATH`.
- An interactive terminal for participating sessions; a persisted session for restart/resume.
- Controlled restart requires OMP's public session and graceful-shutdown APIs. Queue settlement is verified on OMP 18.13.3; the adapter does not duplicate OMP's idle predicate. The read-only private flag-metadata boundary is documented below.

The `ompi` executable is statically linked and does not require Node.js. OMP loads the shipped JavaScript adapter using its own runtime. macOS and Windows are not supported. Resource-only reload and automatic package installation are not implemented.

## Installation

The Ubuntu 26.04 (Resolute) package uses its own dedicated `ppa:klondikemarlen/omp-instance-control` archive. Install after the package has been published:

```bash
sudo add-apt-repository ppa:klondikemarlen/omp-instance-control
sudo apt update
sudo apt install omp-instance-control
ompi control version
```

The package installs `/usr/bin/ompi` and the plugin under `/usr/share/omp-instance-control/`. `ompi` loads it automatically; no separate plugin installation is required for wrapped sessions. Existing processes retain their loaded modules; launch fresh processes after installation or upgrade.

The apt package includes Bash completion at `/usr/share/bash-completion/completions/ompi` and depends on `bash-completion`. Open a fresh interactive Bash shell after installation; no completion setup command or shell-configuration edit is required when the standard Ubuntu Bash completion startup is enabled. Complete controller actions after `ompi control ` and restart targets after `ompi control restart `. Type `-` to discover action-specific options; consumed options are not offered again. Bash offers online IDs for `send`; profile names and restart IDs remain free-form values. Ordinary OMP commands and launch options reuse the installed OMP's generated completion, loaded on first use.

Completion owns only the `ompi` registration. Lazy OMP delegation preserves an existing `omp` completion handler, and the package does not edit shared Bash startup or completion files. If an already-open shell cached a fallback before installation, run `source /usr/share/bash-completion/bash_completion` followed by `complete -r ompi 2>/dev/null`, or open a fresh shell.

The old npm launcher and `omp-instance-control launch` interface are replaced, not aliased. If previously installed globally through npm, remove that old package with `npm uninstall --global omp-instance-control`. Installing only the adapter cannot add instance control to ordinary unwrapped sessions.

To use `/ompi` from ordinary `omp`, install the controller through OMP's public plugin manager:

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

Standard help/version, subcommands, and noninteractive modes retain OMP behavior. `ompi --version` reports the installed OMP version; `ompi control version` reports the wrapper version. Only the first argument `control` selects wrapper commands; names such as `restore` and `instances` outside that namespace pass through to OMP. Interactive launch loads the adapter unless extensions are explicitly disabled.

From another terminal:

```bash
ompi control list
ompi control restart INSTANCE_ID_OR_PREFIX
ompi control restart all
ompi control list --profile work --json
ompi control cleanup
ompi control help
ompi control help restart
```

External restart waits until every accepted target has a verified live replacement. Each pending target has an animated loader; the header shows total observation time (for example, `9m53s elapsed`), restarted/pending counts, and issues. Rows update in place with semantic colors, safely shortened paths, and a pending-first viewport when the terminal is too small. Resizing and Unicode paths do not disable live progress. `NO_COLOR` disables colors, not animation; redirected output and `TERM=dumb` log plain state transitions without cursor controls.

Long project paths shorten from the left to retain the project-name ending; duplicate working directories show a short session suffix. Failed restart rows retain the original project/session record, including in JSON.

Restart injects no preparation or continuation messages and needs no model-generated checkpoint. OMP finishes active work and queued typed prompts before shutting down; the replacement reopens the saved conversation and waits for input. Long-running work can delay restart indefinitely. Explicit exit suppresses relaunch. Progress reports completion only after a live replacement confirms the accepted operation and original instance.

Restart rejects a missing, non-directory, or inaccessible working directory without closing OMP. A restart waiting for transcript persistence checks the directory again before requesting shutdown. These checks do not eliminate filesystem or executable failures after shutdown has begun.

The default list groups peers by working directory. Each row shows a short launch ID, state, and live session title when available; unreachable peers retain a concise failure reason. Use `--json` for full IDs, paths, versions, and restart history. A short ID from the list or status line can select a peer: `ompi control restart 906e493e` or `/ompi restart 906e493e`. A lowercase hexadecimal prefix must match exactly one registration in the scope, including stale registrations. Launch IDs change after relaunch; they are not conversation IDs.

`data.sendContext` in list JSON reports the online child's loaded Send Context version and routing protocol, not the installed package or OMP version. The adapter emits `null` when health metadata is unavailable; older status payloads remain unchanged. Read-only `/health` queries do not claim focus, send prompts, invoke `/ide`, or restart sessions.

Use `ompi control restart all --no-wait` for acknowledgement-only behavior. Waiting is unlimited by default. Ctrl-C stops watching and exits with status 130; it does not cancel accepted requests or kill OMP. `--json` waits too and prints only the final result array; combine it with `--no-wait` when scripts need immediate acceptance.

Every `ompi control restart ID_OR_PREFIX|all` and `/ompi restart [ID_OR_PREFIX|all]` replaces each selected terminal's native `ompi` wrapper as well as OMP. After OMP settles and exits successfully, the wrapper executes its installed replacement and asks OMP to resume the recorded transcript path in its working directory with the adapter reloaded. The recovery slot and its lock survive native replacement; a fresh control identity identifies the new OMP launch. Bare `/ompi restart` selects only the invoking terminal; explicit IDs and `all` retain their profile/config-root scope.

Prompts typed while busy, including `/queue` and `=>` input, belong to OMP's normal follow-up queue. OMP drains that queue before shutdown; ompi neither copies it into a checkpoint nor submits it again after relaunch. A finished turn alone is not proof of settlement: OMP also accounts for admitted submissions and pending async-result delivery. This is a normal settled-restart guarantee, not a claim that arbitrary subprocesses or in-memory work survive crashes.

Repeated requests share one restart operation. No continuation is injected after relaunch; the conversation is ready for your next instruction. Ctrl-C stops an external observer, not the accepted restart.

### OMP Auto-Updates

With OMP auto-update enabled, OMP installs new OMP versions in the background at startup. Existing terminals keep running their loaded version; installing an update does not restart them or replace their loaded code. New terminals use the installed version.

After OMP reports that an update is ready, run `/ompi restart` in a managed terminal when you want it to use the update. OMP finishes active and queued work before the terminal reopens the same saved conversation and directory. Normal PATH-based launches select `omp` again when they relaunch; an explicitly pinned OMP executable remains pinned.

```bash
ompi update --check     # Check for an OMP update without installing it
ompi --version         # OMP selected by a new invocation
ompi control version   # Native ompi wrapper version
```

These version commands start new processes; they do not report which OMP version an already-running terminal has loaded. Likewise, `data.native` in `ompi control list --json` describes the native ompi wrapper, not OMP.

OMP's updater does not install the separate Ubuntu `omp-instance-control` package. Keep OMP's auto-update preference under OMP's control; ompi does not add another installer or restart automatically when OMP updates. See [the update ownership boundary](CONCEPTS.md#omp-auto-update-boundary).

### Updating ompi

Managed launches detect installed-binary changes at startup and every two seconds. A bounded version probe verifies the installed candidate, including atomic replacements whose version string stays unchanged. Detection only notifies: it never requests a restart, installs packages, or patches live instructions.

The notification `Installed native ompi VERSION detected; run /ompi restart to apply.` leaves every terminal running. Use `/ompi restart` for the current terminal, an explicit ID for one peer, or `ompi control restart all` for the selected profile's snapshot. Each requested restart waits for OMP to finish safely before replacing the native wrapper and reopening the conversation.

Notification-only updates require the 0.18.0 or newer adapter to be loaded. Installing an update cannot change code already loaded in a terminal: older 0.16.x–0.17.x adapters retain automatic-update watchers and may initiate one last restart when the installed binary changes. Those processes do not gain the new policy until they relaunch.

`ompi control list --json` and `/ompi list --json` distinguish the running native version, installed version, and update state under `data.native`. An `available` update has not been applied. If a package upgrade replaces `ompi` while a normal restart is waiting, the launcher opens the executable at its original installed path after OMP exits and runs that image. This requires a session running the 2.1.1 or newer wrapper and adapter. Older sessions can still need the printed `ompi control recover` command if the installed image changes during restart.

Existing terminals must first adopt a capable 0.16.0 launcher and adapter through a manual scoped restart. Launchers from before 0.11.0 require one fresh `ompi` launch: they cannot acquire native replacement merely by reloading their adapter. Unsupported targets refuse restart before shutdown rather than falling back to OMP-only restart; a batch retains each target's refusal while independently restarting supported peers. Ordinary unwrapped OMP can control managed peers but cannot restart itself through `ompi`.

From OMP with the plugin loaded:

```text
/ompi restart
/ompi restart INSTANCE_ID_OR_PREFIX
/ompi restart all
/ompi list
/ompi list --profile work
/ompi cleanup
/ompi restore
/ompi help
/ompi help restart
/ompi version
```

Restart targets are positional: omit the target inside OMP for the invoking managed instance, use a full instance ID or unique prefix for one peer, or `all` for a scoped snapshot. Bash requires an explicit target and never guesses a current instance. `list` and `cleanup` accept `--profile NAME` and `--json`; explicit-target restart also accepts `--no-wait`. Word-based `help [COMMAND]` explains each command, and `version` reports controller metadata. Recovery retains its own options below. The old `ompi instances …`, root `ompi restore …`, `/ompi instances …`, and restart `--all`/`--instance` forms are removed, not aliased; migrate shell calls to `ompi control …` and slash calls to the flat commands above. Standard OMP launch arguments, including `--cwd`, are unchanged.

Inside OMP, peer restart waits with animated, themed progress, elapsed time, and Ctrl-C cancellation. A selection containing the invoking wrapped session returns accepted/pending immediately for the entire snapshot: waiting for its own relaunch would prevent shutdown. `--no-wait` works on both surfaces. Use it when invoking the external command as an OMP tool in a selected session.

Autocomplete leads with useful actions, restart targets, and saved recovery names. Options appear only after typing `-`; metadata flags are not repeated at every action. Consumed or conflicting choices are omitted, and value positions never show an option-name menu. Inside OMP, configured profile names and full online instance IDs complete within the selected configuration root and profile, including `--profile NAME` and `--profile=NAME`. IDs are cached per scope and refreshed at startup, after listing or observed peer relaunch, and on session lifecycle events. List the selected profile first to refresh its IDs. Bash delegates all ordinary OMP completion outside `control` without changing the separate `omp` registration.

`restart all` selects a snapshot in the current profile/config-root scope. Replacement instances do not receive the old request. Select another profile explicitly with control-command `--profile`; use the same `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and `XDG_RUNTIME_DIR` as the participating launchers. Named profiles ignore `PI_CODING_AGENT_DIR`, as OMP does.

Run `ompi control cleanup` (or `/ompi cleanup`) to retire old registrations in the selected scope. It requires both a positively absent recorded PID and a missing/refused endpoint, then rechecks private file contents and socket identity before removal. JSON reports each full `instanceId`, `status` (`removed`, `preserved`, or `failed`), and `reason`; native cleanup exits nonzero on failures while still cleaning independent eligible records. Live or reused PIDs, uncertain owners, reachable endpoints, changed files, and socket-only files without records are preserved. Listing and autocomplete remain read-only. Cleanup sends no shutdown/restart requests, and installation never deletes runtime state.

Default cleanup output summarizes removed, retained, and failed registrations, with details for removals and failures. Retained registrations have live or uncertain owners; use `--json` for their complete safety reasons. Cleanup does not stop a live terminal, cancel an accepted restart, or make a busy session settle.

Use `--` before flag-shaped initial messages. Initial messages and startup session actions are never replayed after a controlled restart. For custom string-valued extension flags, use `--custom=value`; for custom boolean flags before a message, separate the message with `--`. An unknown bare flag followed by a non-flag token, a missing string value, or a flag-looking spaced string value makes controlled restart unavailable. Use `--system-prompt=--literal` for a flag-shaped string value. Initial OMP invocation still passes through unchanged.

The wrapper does not register or shadow OMP flags. A parsed extension value sharing a built-in option used by the launch makes controlled restart unavailable rather than guessing its parsing or changing the original invocation. Ordinary spaced options such as `--model MODEL` remain supported.

### Measuring Local Feature Use

Collection is off by default. To measure a month of use, opt in in the shells from which you run native commands and start fresh OMP sessions:

```bash
export OMPI_USAGE=1
ompi control usage           # Read your baseline; reporting does not count.
ompi control usage --json    # Read again at the monthly review.
```

Counts accumulate by feature and surface (native CLI or slash command) in the invoking profile’s effective agent directory under `instance-control/usage-v1/`. Compare two local reports for a period; there is no dated event history. Counts measure attempts, not successes or distinct people. Completion, internal checks and help are not feature use. Run scripts and QA with `OMPI_USAGE=0` if they inherit your shell environment. Collection stores no arguments, message text, identifiers, or project paths and sends nothing over the network. The [monthly review](https://github.com/klondikemarlen/omp-instance-control/issues/105) does not read your counters.

Unset `OMPI_USAGE` for future commands and start fresh terminals without it to stop collection. Previously opted-in processes retain their environment. To erase counts, remove only that scope’s `usage-v1` directory after stopping collection; leave sibling recovery and work state alone.

### Finding Who Owns an Issue or Pull Request

In the managed terminal doing the work, register the GitHub issue or pull request and a short description:

```text
/ompi work set --branch issue-93/session-work https://github.com/klondikemarlen/omp-instance-control/issues/93 Implement ownership lookup
```

`set` replaces this conversation's previous claim. Repeat it to refresh the timestamp, or use `/ompi work clear` when you hand off the task. The working directory comes from the live terminal; the branch and summary are your assertions, not inferred Git state. Omit `--branch` if it is not relevant. Use public or local-safe descriptions: don't include credentials, prompts, or private review text.

From another project, look up the qualified URL rather than guessing from a title or issue number:

```bash
ompi control work list
ompi control work find --json https://github.com/klondikemarlen/omp-instance-control/issues/93
```

`find --json` returns an array, not a single recipient. Check `availability`, `stale`, `conflict`, and `updatedAt` before choosing an ID from `instanceIds`. A claim is stale after 24 hours. An empty array means no conversation registered that URL in this scope, not that nobody is working on it. If ownership is unclear, don't send. Lookup never sends a message.

The native CLI can also set or clear a claim for an explicitly selected live ID: `ompi control work set ID URL 'Summary with spaces'` or `ompi control work clear ID`. The slash forms mutate only the invoking managed session. Both command surfaces require the work-capable native `ompi` executable.

### Sending Peer Messages

**Known peer in the same folder:** On OMP 19, if both interactive sessions have [`task.crossInstance`](https://github.com/can1357/oh-my-pi/blob/v19.0.1/packages/coding-agent/src/task/settings.ts#L508-L519) enabled, an agent can read `agent://peers` and write a message to `agent://<pid>` for the intended main agent. The roster shows PIDs and status, not session titles. This setting is off by default: opting in also lets participating peers read subagent outputs and send messages that can wake agents.

**Peer in another project, or several sessions in one folder:** Use `ompi control list` (or `/ompi list`) to compare working directories and live session titles. Address the chosen session by launch ID, not PID or title. Give your own conversation a useful title with OMP's `/rename`, for example `/rename Review CSV exports`. Re-list after a rename or restart. Titles can be absent, duplicated, or out of date with the work; if the intended recipient is still unclear, do not send.

For a compact project directory, list online peers with their full launch IDs, working directories, and titles:

```bash
ompi control list --json | jq -c '.[] | select(.status == "online") | [.record.instanceId, .data.cwd, .data.sessionTitle]'
```

Send to the selected instance's current full ID or unique hexadecimal prefix, never its title:

```bash
ompi control send ID 'Please investigate the API failure in your project.'
ompi control steer ID 'Pause that approach; check the latest user correction first.'
ompi control send --json --profile work ID 'Please report the current blocker.'
```

Inside OMP, use `/ompi send ID message` or `/ompi steer ID message`. Options precede the target. Bash requires one quoted message argument; the slash command takes everything after the target as literal text, without shell quote interpretation. Unicode and newlines are preserved, up to 16 KiB of UTF-8 text. Completion stops at the message body rather than suggesting more flags.

`send` joins OMP's follow-up queue behind current work; `steer` redirects work at a supported agent boundary. These are separate verbs, not `send --steer`. Either starts a model turn when the receiver is idle and can therefore incur the receiver's normal model cost. Messages are visibly marked as agent-attributed peer context, not new user instructions or permission to cross repository boundaries. The channel does not authenticate an originating agent identity; same-user local programs can send requests.

Received messages show a plain peer-context label and a two-line preview, without a surrounding card. Expand tool output (Ctrl+O by default) to read the complete message. Only the display is shortened: the conversation and model retain the full peer-not-user envelope and literal message. Terminal control bytes are displayed as escapes.

`submitted` acknowledges handoff to OMP's public message API, not durable queueing, processing, a reply, or completion. JSON includes the selected `instanceId`, `data.messageId`, and `data.delivery`. A timeout or lost acknowledgement is unknown: inspect the recipient before explicitly trying again, because an automatic resend could duplicate work. Missing, ambiguous, stale, closing, or older unsupported targets fail without falling back to another terminal. There is no `all` message target. Profile/config-root boundaries remain the same as discovery and require explicit cross-profile selection.

Both the receiver's launcher-loaded adapter and sender need messaging-capable code; already-running terminals retain their old modules. Choose a scoped restart or fresh launch after upgrading. This channel is separate from restart: it neither shuts down terminals nor restores checkpoint prompts. Automatic work routing and delegation policy belong to the calling agent's skills, not ompi.

### Taking Over a Plain-OMP Session

With the plugin loaded in ordinary `omp` and the native `ompi` executable on `PATH`, run:

```text
/ompi take-over
```

Copy the shell command from the dialog, then confirm graceful exit. After OMP has exited and your shell prompt returns, paste that command once in the same terminal. It passes the saved session path to OMP under `ompi`, preserving the working directory, profile, config root, default-profile agent-directory override, and runtime-directory scope.

The command is a snapshot of the session you selected; do not switch sessions while waiting for exit. Preparation is saved in session metadata without starting a model turn. Cancelling the dialog or changing sessions before confirmation leaves OMP running. Missing, empty, or ephemeral session files, an unavailable `ompi`, and control characters in command values are refused before shutdown. Already wrapped sessions use `/ompi restart` instead.

OMP owns settlement, transcript persistence, teardown, and terminal release. There is no automatic takeover, process killing, terminal-input injection, or replay of original startup arguments. The manual paste is required because plain OMP has no wrapper parent to relaunch it.

### Recovering Sessions After Reboot

Managed `ompi` sessions are captured automatically once their transcript exists. No restore name is required. Recovery checkpoints retain the active managed slots outside the runtime directory. The default menu prefers the latest previous-boot set, but an empty older boot does not hide current-boot recovery data. A latest empty current-boot set remains empty after normal exit; recovery does not search older sets to resurrect closed sessions.

After your terminal restores its Bash tabs, run this in each tab:

```bash
ompi control restore
```

Select a slot and confirm its exact session ID and working directory. `ompi control restore list` lists candidates; add `--json` for structured output. Use `ompi control restore slot FULL_SLOT_ID` to select directly and `--profile work` explicitly for another OMP profile. Recovery runs only in the terminal where you invoke it; it does not open terminal windows or modify shell startup.

Managed recovery reopens the conversation for inspection; it does **not** ask OMP to continue interrupted turns or subagents. Check which conversation opened before asking it to continue. OMP 19.0.1 may follow a newer continuation of the selected transcript even when given its absolute path. Native `omp --restore` can resume unfinished work, including tool calls, and is not a substitute for inspecting a managed slot. Normal graceful restart still waits for OMP to settle.

Manual recovery and restore preserve the saved profile and plugin configuration root. A restored conversation with missing plugin commands is not evidence that the plugins were uninstalled. Before 2.1.1, restore could open the transcript but look for plugin packages under a second copy of the home path.

If you launched an older wrapper with `--restore`, exit normally rather than requesting a restart. Version 1.2.1 omits the old flag when reading a saved slot. It refuses pending or failed restart handoffs that still request native restore. If your handoff is refused, wait until the original processes have stopped, then use a fresh wrapper in the original project and profile with `-r /absolute/path/to/session.jsonl`. Do not edit a recovery record to bypass a refusal.

Optional names remain available:

```text
/ompi restore save payments-main
```

From another terminal, use `ompi control restore save payments-main --instance FULL_INSTANCE_ID`. Names use up to 64 letters, digits, dots, underscores, or hyphens, starting with a letter or digit; `save` is reserved. `ompi control restore payments-main` selects that slot directly. For names matching an operation word, use `ompi control restore name history` or `/ompi restore name history`. A name stays bound to its evolving wrapper slot, not to its original project directory or a frozen transcript bookmark. Saving an existing name again is refused.

`ompi control restore checkpoint` saves a manual membership checkpoint. `ompi control restore history` lists retained checkpoints; `ompi control restore from CHECKPOINT_ID` restricts selection to that checkpoint. `list` and `export` accept `--from CHECKPOINT_ID`; `list` and `history` accept `--json`. Operations are words, not flags: the old `--history`, `--list`, `--checkpoint`, `--slot`, `--export`, and `--import-legacy` spellings are no longer accepted. A checkpoint freezes membership, not transcript contents: each slot follows its latest safely captured session and cwd through switches, branches, and controlled restarts. Unchanged automatic membership reuses the latest same-boot checkpoint, including concurrent captures; actual membership/session/cwd changes and manual captures create new history. Normal exit excludes the closing slot, including when the resulting checkpoint is empty. The newest ten checkpoints are retained, plus the newest previous-boot checkpoint when it falls outside that set, for at most eleven.

Private state lives under the selected agent directory at `instance-control/restore/`, outside `XDG_RUNTIME_DIR`. Exact transcript paths and safe launch options are retained without copying transcripts or replaying startup prompts. Missing or not-yet-written transcripts stay quietly unavailable and invalidate predecessor snapshots; recovery never silently opens an older conversation. Unsafe paths, a live launcher or OMP child, uncertain ownership, or a concurrent restore holding the slot lock refuse launch.

Recovery requires trusted ancestors that are not group- or world-writable. If an ordinary launch cannot prepare that store safely, it reports recovery as unavailable and continues without a recoverable slot; standard OMP invocation and existing restart eligibility are unchanged. Correct only the reported owned directory's permissions, then start a fresh launcher. For example, `chmod go-w ~/.omp` removes group/other write access from an owned, group-writable OMP config root; the wrapper never changes those permissions for you.

`/ompi restore` provides the same recovery operations inside OMP. Selection displays a quoted shell command before confirmation and graceful exit: copy it, wait for your shell, then paste it. No nested OMP terminal is started. Both command surfaces complete operation words and optional saved names; type `-` to see relevant modifiers or use `help restore`. Generated managed restore commands require native `ompi` 0.19.0 or newer for word-based restore syntax.

Ptyxis restores layout, profile, and cwd, but does not supply a durable per-tab identity or save custom command argv in its [50.1 session format](https://sources.debian.org/data/main/p/ptyxis/50.1-1/src/ptyxis-session.c). This explicit menu does not change Ptyxis profiles or Bash startup. Verification covers real Ptyxis close/reopen on an isolated headless display and loss of the isolated runtime directory, not an OS reboot of the workstation.

Start a fresh `ompi` launcher after upgrading: launchers started before 0.9.0 cannot supply restore metadata merely by restarting their OMP child. Resume the existing session under the new launcher before naming its slot.

### Reading Previously Imported Checkpoints

The legacy importer was removed in 2.0. Original helper files are left untouched. Checkpoints already imported remain visible in `ompi control restore history` until normal history pruning. Use `ompi control restore list --from CHECKPOINT_ID` to inspect one or `ompi control restore export --from CHECKPOINT_ID` to print manual resume commands. These entries are not managed slots and cannot launch automatically.

## Outcomes and Safety

- `accepted` means one restart operation is retained, not that restart completed. A fresh persistent session waits for its first saved response before graceful shutdown is requested; an allocated transcript path is not yet a resumable file. Truly ephemeral sessions are refused. Active turns, queued submissions, and background jobs remain OMP's responsibility. A stuck or never-materialized session stays pending; the helper never kills it or fabricates a transcript.
- If a restart remains pending, check `ompi control list --json` from another terminal with the same config and runtime directories; pass `--profile NAME` for a named profile. The original instance reporting `restart-requested` has not been replaced. An unavailable endpoint during shutdown is not proof of completion. Do not send another prompt, repeat the restart, or press Ctrl-C in the target to hurry it along.
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

As of [OMP 19.0.1](CONCEPTS.md#host-api-dependency), same-folder agent messaging and local `/restart` cover part of this workflow. Neither replaces cross-project launch selection, settled remote restart with a confirmed replacement, or managed recovery. No wrapper responsibility in the table can yet be removed in full.

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

The checkout's `.tool-versions` pins Go, golangci-lint, and ShellCheck for development. With asdf shims on `PATH`, register any missing plugins once, then install the pinned versions from this directory:

```bash
asdf plugin add golang https://github.com/asdf-community/asdf-golang.git
asdf plugin add golangci-lint https://github.com/hypnoglow/asdf-golangci-lint.git
asdf plugin add shellcheck https://github.com/luizm/asdf-shellcheck.git
asdf install
```

These pins do not change your home defaults. You also need Node.js 22.13+ and RuboCop 1.92+; `npm ci` installs the JavaScript lint dependencies from `package-lock.json`. Without asdf, put the pinned tool versions on `PATH` yourself.

```bash
npm ci
npm run build
npm test
npm run format
npm run check
git diff --check
./dist/ompi control help
```

`npm run check` runs Go vet, linting, and formatting checks. `npm run lint` checks Go (`govet`, `ineffassign`, `unused`), JavaScript (ESLint recommended rules, zero warnings), the Ruby development wrapper (RuboCop), and Bash (ShellCheck). To reproduce a Verifier check, run `./bin/dev lint` with the language `go`, `js`, `ruby`, or `shell`. These commands report violations without fixing files.

`make build` produces `dist/ompi` without cgo or runtime dependencies. The installed wrapper resolves its adapter relative to the real executable, not the working directory.

Follow issue-named branches, linked PRs, complete self-review, focused QA, and merge commits. Create or verify the dedicated public [OMP Instance Control PPA](https://launchpad.net/~klondikemarlen/+archive/ubuntu/omp-instance-control) before uploading. Do not reuse another project's archive.

Development commands require Ruby and the `marlens-skills-rules-and-tools` OMP plugin installed under `~/.omp/plugins/`. Run `./bin/dev sign` directly from the checkout; `./dev` is a directory containing the project plugin, not an executable. To use the shorter `dev sign`, add `PATH_add bin` to an ignored local `.envrc`, then run `direnv allow`. Your shell must have the direnv hook enabled; otherwise use `./bin/dev`.

From a clean, committed release checkout, `dev package` prepares an unsigned source upload using only tracked files. `dev package binary` builds a local binary package. Both keep outputs under ignored `build/debian/` and remove their temporary staging tree after the build. Existing artifacts are never overwritten; keep them or increment `debian/changelog` before preparing another build.

Run `dev sign` in your terminal to sign the current prepared upload. It selects the source/version from `debian/changelog`, sets `GPG_TTY`, and uses `debsign`'s normal maintainer-key selection. Install the helper once with `sudo apt install --no-install-recommends devscripts` if needed. Enter the existing key's passphrase locally; signing neither rebuilds nor uploads, and an already signed upload is left unchanged.

```bash
dev package
dev sign
source=$(dpkg-parsechangelog --show-field Source)
version=$(dpkg-parsechangelog --show-field Version)
dput ssh-ppa:klondikemarlen/omp-instance-control "build/debian/${source}_${version}_source.changes"
```

SFTP uses your local username unless a `dput` login is configured; set it to your Launchpad account when the names differ.

Wait for Launchpad's Resolute/amd64 build and public package index before claiming publication. Download the released package, uninstall the isolated QA installation, reinstall that artifact, verify its version, and exercise standard commands, restart/resume, and `/ompi` autocomplete in fresh isolated OMP processes. Also uninstall/reinstall the public GitHub plugin and verify its version and ordinary-OMP peer controls in a fresh process. System installation additionally requires authorized apt access; isolated-root QA is not a system-install claim.

Runtime QA uses isolated homes/config roots and real terminals. Verify current session/cwd, fresh module loading, profile isolation, duplicate-request coalescing, normal exit, and settlement with queued prompts/background delivery. Do not change the operator's configured models, credentials, or plugins during QA.
