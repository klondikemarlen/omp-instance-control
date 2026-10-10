# OMP Instance Control

`ompi` layers instance control on top of standard `omp`. Bare `ompi` launches OMP in the current terminal; normal OMP arguments and subcommands pass through. The additional `instances` command group discovers participating terminals and requests settled-boundary restart/resume.

OMP owns settlement, transcript persistence, and graceful teardown. The native Go wrapper reopens the current persisted conversation in the same terminal after successful shutdown.

## Requirements

- Linux and an independently installed `omp` on `PATH`.
- An interactive terminal for participating sessions; a persisted session for restart/resume.
- OMP 18.8.7 is the initial verification target. Lifecycle actions use public extension APIs; one read-only private flag-metadata boundary is documented below.

The `ompi` executable is statically linked and does not require Node.js. OMP loads the shipped JavaScript adapter using its own runtime. macOS and Windows are not supported. Resource-only reload and automatic package/executable upgrades are not implemented.

## Installation

The Ubuntu 26.04 (Resolute) package follows the existing Firefox-host PPA convention:

```bash
sudo add-apt-repository ppa:klondikemarlen/omp-send-context
sudo apt update
sudo apt install omp-instance-control
ompi instances --version
```

The package installs `/usr/bin/ompi` and the adapter under `/usr/share/omp-instance-control/`. No separate OMP plugin installation is required. Existing processes retain their loaded modules; launch fresh processes after installation or upgrade.

The old npm launcher and `omp-instance-control launch` interface are replaced, not aliased. If previously installed globally through npm, remove that old package with `npm uninstall --global omp-instance-control`. Installing only the adapter cannot add instance control to ordinary unwrapped sessions.

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
ompi instances restart --instance FULL_INSTANCE_ID
ompi instances restart --all
ompi instances list --profile work --json
ompi instances --help
```

From a participating OMP instance:

```text
/instances list
/instances restart --instance FULL_INSTANCE_ID
/instances restart --all
```

`--all` selects a snapshot in the current profile/config-root scope. Replacement instances do not receive the old request. Select another profile explicitly with control-command `--profile`; use the same `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and `XDG_RUNTIME_DIR` as the participating launchers. Named profiles ignore `PI_CODING_AGENT_DIR`, as OMP does.

Use `--` before flag-shaped initial messages. Initial messages and startup session actions are never replayed after a controlled restart. For custom string-valued extension flags, use `--custom=value`; for custom boolean flags before a message, separate the message with `--`. An unknown bare flag immediately followed by a non-flag token has ambiguous arity: initial OMP invocation still passes through, but controlled restart is explicitly unavailable rather than risking prompt replay.

The wrapper does not register or shadow OMP flags. If another extension overrides a built-in option used by the launch, controlled restart is unavailable rather than guessing its parsing or changing the original invocation. Ordinary spaced options such as `--model MODEL` remain supported.

## Outcomes and Safety

- `accepted` means OMP's graceful shutdown was requested, not that restart completed. Active turns, queued submissions, and background jobs remain OMP's responsibility. A stuck instance stays pending; the helper never kills it.
- A replacement's `lastRestart` identifies the completed operation and previous instance. Every boot has a fresh instance identity, independent of PID or transcript ID.
- `failed` reports explicit rejection, including a missing persisted session or no matching target. `unreachable` means a missing/refused endpoint; `unknown` means acknowledgement was inconclusive. Requests are never automatically replayed.
- Normal `/exit`, unsuccessful child exit, and termination signals do not relaunch. Handoffs are validated and consumed once after successful child exit.
- Relaunch resumes the actual current session file and cwd, not the original selector. Original configuration paths and relative default-profile agent-directory overrides remain anchored across directory changes.
- Restart admission checks OMP's private parsed extension-flag map read-only at `session_start`. Missing metadata or a built-in collision refuses restart before shutdown. This explicit compatibility dependency is verified on OMP 18.8.7; it does not mutate flags or replace public lifecycle APIs.
- Private same-user Unix sockets and discovery records live under `$XDG_RUNTIME_DIR/omp-instance-control`, or `/tmp/omp-instance-control-<uid>` when unset. Unsafe permissions, symlinks, and overlong socket paths fail explicitly.
- Crashed instances can leave unreachable records. Discovery reports them without deleting another instance's state. Same-user IPC is not a sandbox against other programs running as your account.

## Temporary Ownership and Upstream Removal

Track [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458). Keep this wrapper additive; remove functionality when OMP supplies the corresponding supported contract:

| Current Wrapper Responsibility                                       | Removal Criterion                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Foreground relaunch, one-shot handoff, and launch-argument rewriting | Public settled-boundary restart/resume request API owns persistence, terminal handoff, and argument rewriting.         |
| JavaScript shutdown/handoff adapter                                  | Supported host lifecycle and instance-control APIs replace its public extension callbacks.                             |
| Read-only parsed extension-flag compatibility guard                  | Supported parsed-flag metadata is exposed, or OMP owns restart argument selection.                                     |
| Scoped instance discovery, Unix sockets, and request dispatch        | OMP exposes supported same-user discovery/control preserving profile/config-root boundaries and per-launch identities. |
| The `ompi` executable/package                                        | Standard `omp` supplies all required instance-control commands; migrate usage and remove the redundant wrapper.        |

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

Follow issue-named branches, linked PRs, complete self-review, focused QA, and merge commits. Build and sign the Debian native source package from the merged release checkout:

```bash
dpkg-buildpackage -S -d -kYOUR_UPLOAD_KEY
dput ppa:klondikemarlen/omp-send-context ../omp-instance-control_0.2.0~ppa1_source.changes
```

Wait for Launchpad's Resolute/amd64 build and public package index before claiming publication. Download the released package, uninstall the isolated QA installation, reinstall that artifact, verify its installed version, and exercise standard commands, restart/resume, and `/instances` autocomplete in fresh isolated OMP processes. System installation additionally requires authorized apt access; extracted-package QA is not a system-install claim.

Runtime QA uses isolated homes/config roots and real terminals. Verify current session/cwd, fresh module loading, profile isolation, duplicate-request coalescing, normal exit, and settlement with queued prompts/background delivery. Do not change the operator's configured models, credentials, or plugins during QA.
