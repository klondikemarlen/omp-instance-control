# OMP Instance Control

Request settled-boundary restart/resume across participating OMP terminals on Linux, including Ubuntu. Each terminal must start through the launcher. OMP owns settlement and graceful teardown; the launcher reopens the current persisted conversation in the same terminal.

## Requirements

- Linux, Node.js 22 or newer, and `omp` on `PATH`.
- An interactive terminal and a persisted OMP session.
- OMP 18.8.7 is the initial verification target. The integration uses public extension APIs, not private host imports.

macOS and Windows are not supported. Resource-only plugin reload is not available through this helper. Restart loads fresh extension modules and configuration; it does not install or upgrade anything.

## Installation

Install the versioned GitHub release artifact:

```bash
npm install --global https://github.com/klondikemarlen/omp-instance-control/releases/download/v0.1.0/omp-instance-control-0.1.0.tgz
omp-instance-control --help
```

The launcher explicitly loads the shipped OMP extension; a separate OMP plugin installation is not required. The repository also supports OMP's plugin discovery:

```bash
omp plugin install github:klondikemarlen/omp-instance-control
```

Installing the extension alone cannot restart ordinary, unwrapped OMP sessions. Existing processes retain their loaded modules; start fresh processes for installation verification.

## Usage

Start each participating terminal through the launcher:

```bash
omp-instance-control launch --cwd /path/to/project
omp-instance-control launch --profile work --resume SESSION_ID
```

Use `--help` for supported OMP launch options. Unknown options fail explicitly rather than being silently dropped. Use `--` before flag-shaped initial messages so they remain messages, not OMP options. Initial messages are used only on the first launch, never replayed after a controlled restart.

From another terminal:

```bash
omp-instance-control instances list
omp-instance-control instances restart --instance FULL_INSTANCE_ID
omp-instance-control instances restart --all
omp-instance-control instances list --profile work --json
```

From a participating OMP instance:

```text
/instances list
/instances restart --instance FULL_INSTANCE_ID
/instances restart --all
```

`--all` selects a snapshot in the current profile/config-root scope. Replacement instances do not receive the old request. Select another profile explicitly with CLI `--profile`; use the same `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and `XDG_RUNTIME_DIR` as the participating launchers. Named profiles follow OMP's rule of ignoring `PI_CODING_AGENT_DIR`.

## Outcomes and Safety

- `accepted` means OMP's graceful shutdown was requested, not that restart completed. Active turns, queued submissions, and background jobs remain OMP's responsibility. A stuck instance stays pending; the helper never kills it.
- A replacement's `lastRestart` identifies the completed operation and previous instance. Each launch has a fresh instance ID, independent of PID or transcript ID.
- `failed` reports explicit rejection, including a missing persisted session or no matching target. `unreachable` means a missing/refused endpoint; `unknown` means acknowledgement was inconclusive. Requests are never automatically replayed.
- Normal `/exit`, nonzero child exit, and termination signals do not start another process. A restart handoff is validated and consumed once after successful exit.
- The next launch resumes the actual current session file and working directory, not the original selector. Configuration paths and relative default-profile agent-directory overrides are retained across directory changes.
- Private same-user Unix sockets and discovery records live under `$XDG_RUNTIME_DIR/omp-instance-control`, or `/tmp/omp-instance-control-<uid>` when unset. Unsafe permissions or symlinks fail rather than being repaired silently. Overlong socket paths fail with an actionable error.
- Crashed instances can leave unreachable records; discovery reports them without deleting another instance's state. Same-user IPC is not a sandbox against other programs running as your account.

## Repository Layout

- `omp/`: public OMP integration and handoff binding.
- `cli/`: command entry point, shared selection, and outcome reporting.
- `protocol/`: scoped identities and request/response contracts, independent of Linux transport paths.
- `linux/`: private filesystem/socket transport and the foreground launcher.
- `test/<integration>/`: deterministic behavior tests.

See [Concepts](CONCEPTS.md) and [Changelog](CHANGELOG.md). The upstream lifecycle feature remains tracked in [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458). This release uses the explicitly selected launcher workaround; it does not claim that OMP exposes restart or plugin-refresh request APIs.

## Development and Release

```bash
npm ci
npm test
npm run check
git diff --check
```

For runtime QA, use isolated homes/config roots and real OMP terminals. Verify active turns, queued prompts, background delivery, exact session/cwd resume, fresh extension loading, profile isolation, normal exit, and duplicate-request coalescing. Do not change the operator's installed plugins or configured model routes during QA.

Follow issue-named branches, linked pull requests, complete self-review, focused QA, and merge commits. After merge, package with `npm pack --pack-destination /tmp`, publish the versioned tarball as a GitHub release asset, download the remote asset, uninstall the QA installation, reinstall the released artifact, check its version, and exercise behavior and `/instances` autocomplete in fresh isolated OMP processes. No npm-registry publication is implied.
