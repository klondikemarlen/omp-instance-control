# Concepts

## Purpose

Give an operator or another OMP instance an explicit way to request safe restart/resume across participating Linux terminals without interrupting their work.

## Ownership

| Boundary                                                              | Owner       |
| --------------------------------------------------------------------- | ----------- |
| Target selection, snapshot broadcasts, and outcomes                   | `cli/`      |
| Profile/config scope, launch identity, and wire validation            | `protocol/` |
| Private discovery records, Unix sockets, and foreground relaunch      | `linux/`    |
| Public extension registration, shutdown requests, and handoff capture | `omp/`      |
| Settlement, transcript persistence, teardown, and terminal release    | OMP core    |

A control endpoint belongs to a main interactive launch, not a subagent or persisted transcript. Instance identity changes on every boot, including native POSIX restart that can retain the PID. A launcher token binds a handoff to one child launch; it is not a network credential.

A user-facing restart selector may be a unique lowercase hexadecimal prefix of the current instance ID. The client resolves it against one profile/config-root-scoped discovery snapshot, retaining stale registrations when checking ambiguity. No lifecycle request is sent until exactly one record matches; protocol requests, result identities, and restart correlation continue using full 32-character IDs. A session ID identifies the persisted conversation instead and is not a restart selector.

## Settled Restart Handoff

1. The client reads a profile/config-root-scoped snapshot and sends one request per selected instance.
2. The extension requires a live launcher and a persistent transcript path. Concurrent requests coalesce into one operation. A fresh session may not have materialized its allocated file yet; its request remains pending instead of being confused with an ephemeral session.
3. After acknowledgement flush and once the current transcript exists, the extension calls public `ctx.shutdown()` once. Public lifecycle updates observe persistence readiness only: they do not prove settlement. The extension neither polls `ctx.isIdle()` nor equates `agent_end` with settlement, forces private persistence, or fabricates an empty transcript.
4. OMP waits for its settled boundary, including queued submissions and background deliveries. During `session_shutdown`, the extension synchronously captures the current session file and cwd in a private atomic handoff, then removes its endpoint.
5. After successful child exit, the launcher validates and consumes the handoff once. It relaunches with inherited terminal streams, retained configuration, and the current absolute session file; it strips the original messages and old selector.
6. A fresh mounted endpoint exposes `lastRestart.operationId` and `lastRestart.previousInstanceId`. External CLI and in-OMP peer observation wait until a live status probe confirms both values against the accepted operation and original instance. Acceptance, disappearance, or PID changes alone are not completion.

Normal exit without a handoff does not restart. Nonzero child exit and launcher termination signals prevent relaunch. A native OMP `/restart` can replace the child in-place; its new plugin binding clears a same-token handoff so a later `/exit` cannot replay it.

`/ompi restart` selects only the invoking managed identity and uses the distinct `restart-wrapper` action. The launcher advertises native-replacement capability; an absent capability refuses this action before shutdown. Child-only and wrapper restart requests cannot coalesce into an operation with different semantics. After a successful child exit, the native launcher transfers validated scope, safe arguments, current session/cwd, recovery slot, and restart correlation in private single-use state and executes the installed wrapper. The same kernel-lock open-file description survives exec and is revalidated against the slot before launching OMP. Internal transfer variables are consumed, not forwarded to OMP. A failed exec reports an error instead of retrying or launching a duplicate session. Explicit exit precedence remains unchanged.

A matching explicit exit request from `omp-exit-command:exit-requested` takes precedence over an accepted restart. The event carries the active session ID and is emitted immediately before native OMP shutdown; the adapter ignores malformed, unrelated-session, or non-main requests. A matching request suppresses the restart handoff, while OMP still owns settlement and teardown. The accepted operation is not completion: without a correlated replacement, restart observers must not report it successful. A request whose acknowledgement is lost has an unknown outcome; clients never retry automatically.

Before binding an endpoint, each instance writes a private registration handoff containing the launcher token, scope, fresh instance ID, and host PID. Native OMP restarts retain earlier identity handoffs even when the PID stays the same. Only after `cmd.Wait` has reaped the child does the launcher validate these handoffs and remove matching, unchanged private records/sockets. Cleanup uses the launch token and actual reaped child, not PID-existence guesses. Changed identities, unsafe paths, and legacy registrations without ownership proof are preserved; discovery itself remains read-only.

Explicit `cleanup` is the legacy migration boundary: it checks signal zero for `ESRCH` (positive process absence), requires a missing/refused Unix endpoint, and revalidates private record bytes and socket inode before unlinking. A present PID may be a reused process and is conservatively preserved; `EPERM` and other uncertainty are not proof of absence. Unsafe files fail without deletion, changed identities are preserved, and socket-only files lack sufficient ownership evidence. List and completion never invoke cleanup. No package installation script sweeps runtime state.

Observation has no default deadline. Ctrl-C stops watching without cancelling an accepted restart or killing OMP. Missing endpoints and status connections closed during teardown remain a `restarting` transition; malformed or uncorrelated acknowledgements remain unknown, never successful. In-session peer commands wait by default, but any selection containing the invoking wrapped session returns acceptance for the whole snapshot because waiting would block its own settlement. `--no-wait` is explicit on both surfaces.

The installed controller can run in ordinary OMP without publishing an endpoint. Only a launcher-managed main terminal is a restart target. Installed and injected extension paths can both be bound by the host, even when they resolve to the same file. A synchronous claim on the public extension event bus gives that host one registration owner; shutdown releases the claim. It does not use PID identity, private registration state, or process-global ownership.

`/ompi take-over` prepares a manually invoked resume command for an ordinary-OMP session. It resolves configuration paths against the host process directory, shell-quotes the current persisted session and cwd, displays a copy-and-confirm dialog, and revalidates the snapshot before public shutdown. The command is stored through public `appendEntry` without injecting a model message. OMP still owns settlement; the user waits for the shell and pastes the prepared command. This is not automatic executable or terminal handoff, and the prepared snapshot is not rewritten if the user switches sessions during a pending exit.

## Managed Recovery Slots

A recovery slot identifies a persistent managed wrapper independently of its ephemeral control instance ID. The slot keeps the latest public session ID/file and cwd through lifecycle changes. Optional immutable names are aliases for these slots; they are not required for recovery or frozen transcript bookmarks.

`linux/restore.js` atomically captures private snapshots beneath the effective agent directory, outside runtime discovery state. The launcher supplies a stable slot ID and normalized resume arguments; the adapter adds the current OMP process identity. Snapshots retain explicitly selected transcript paths without moving or copying transcripts. An uncapturable current session invalidates its predecessor; an unmaterialized transcript stays quietly pending instead of reporting a startup error.

Recovery checkpoints freeze scoped active-slot membership, not a slot's future conversation. They include only persisted snapshots matching live scoped discovery records. Graceful shutdown excludes the closing slot; an empty checkpoint is meaningful. Default selection prefers the newest non-legacy checkpoint from another boot, otherwise the latest current-boot checkpoint, and includes optional named slots. Explicit checkpoint selection restricts membership. Retention keeps the newest ten checkpoints and protects the newest previous-boot checkpoint, with at most eleven total.

Native recovery validates the selected scope and paths, holds a per-slot kernel lock for the foreground launch, and refuses live or uncertain ownership. It rechecks the snapshot shown in confirmation under that lock rather than launching a changed conversation. Ordinary recoverable launches acquire the same lock. OMP inherits its descriptor before startup; closing the launcher's descriptor does not unlock a surviving child, even before the child records its identity. Launcher and OMP child identities include Linux boot ID, PID, and process start time. Neither a missing PID alone nor a vanished socket authorizes restore.

Both command surfaces expose selection, optional naming, checkpoint history, import, and export. The OMP command prepares a scope-anchored quoted shell command and requests public graceful shutdown only after confirmation; the operator pastes it after terminal release. The native command performs final confirmation and ownership validation. Neither surface opens terminals or changes Ptyxis or Bash startup.

Legacy command snapshots are parsed as bounded data, never evaluated. Their transcript IDs resolve only within the selected scope's session tree. Content/path-derived checkpoint identities make import idempotent; originals remain untouched. Because the old helper did not record verified managed ownership, imports remain review/export-only. Managed exports preserve slot locking through `ompi control restore --slot`; legacy exports clearly identify manual, unowned resumes. Automatic discovery never scans arbitrary OMP processes.

## Scope and Trust

Scope includes OMP config root, normalized profile, and effective agent directory. Default-profile `PI_CODING_AGENT_DIR` overrides remain distinct; named profiles ignore that override, as OMP does. The Linux transport chooses its own private runtime path. Shared client code receives a transport object and never constructs Linux socket paths.

Directories are private, owned by the current user, and have trusted non-writable ancestors. Records and sockets are private. Symlink paths and unsafe permissions are rejected. These controls protect against other Unix users, not processes already running under the same account.

## Reload Versus Restart

Resource discovery/MCP reconnects are not extension-module reload or executable upgrade. OMP 18.8.7's `/reload-plugins` retained an edited extension module in the original isolated investigation; native `/restart` loaded it anew while preserving the session and terminal.

This helper implements restart only. It loads code/configuration present on disk at the next launch, without performing package installation or executable upgrades. Unwrapped, ephemeral, or never-materialized sessions cannot claim restart/resume through the helper.

## Host API Dependency

Track [can1357/oh-my-pi#6458](https://github.com/can1357/oh-my-pi/issues/6458). The OMP 18.12.2 compatibility audit retains the Linux launcher workaround: the public extension context exposes graceful `shutdown()` and read-only session access, but no supported restart/resume request or same-user instance discovery/control contract. None of the [wrapper removal criteria](README.md#temporary-ownership-and-upstream-removal) is fully met.

Versioned source contracts:

- [Extension context](https://github.com/can1357/oh-my-pi/blob/v18.12.2/packages/coding-agent/src/extensibility/extensions/types.ts): public `shutdown()`, current `cwd`, read-only session access, and session lifecycle events. Built-in `/restart` does not imply a public extension restart method.
- [Interactive lifecycle](https://github.com/can1357/oh-my-pi/blob/v18.12.2/packages/coding-agent/src/modes/interactive-mode.ts): OMP owns the settled shutdown-request path, native restart, and terminal teardown. The internal `restart()` implementation is not a supported extension request API.
- [Extension flag binding](https://github.com/can1357/oh-my-pi/blob/v18.12.2/packages/coding-agent/src/extensibility/extensions/loader.ts): public `getFlag()` remains scoped to the calling extension; parsed cross-extension flags remain runtime metadata rather than a supported public contract.

An isolated OMP 18.12.2 launch with the installed 0.8.1 wrapper verified graceful shutdown, correlated replacement, preserved session ID/file/cwd, and normal-exit endpoint cleanup. A separate extension's flag remained unavailable through public `getFlag()`. This audit does not replace the historical 18.8.7 module-reload experiment above with an unobserved claim about current `/reload-plugins` behavior.

The launcher does not duplicate OMP's settlement predicate, abort tools, kill sibling instances, inject lifecycle keystrokes, or import private OMP internals.

### Parsed Extension-Flag Compatibility Decision

Preserve normal spaced OMP arguments and keep the wrapper additive. The wrapper does not register built-in flags. OMP permits extensions to override their names; for example, a boolean extension flag named `plan` makes `--plan "startup prompt"` submit that text instead of consuming it as the built-in value.

Public `getFlag()` only sees flags registered by the calling extension, not other plugins; this was originally verified on 18.8.7 and rechecked on 18.12.2. The explicit compatibility decision is to read the private `pi.runtime.flagValues` map at `session_start`, without modifying it or registering observer flags. The [host implementation](https://github.com/can1357/oh-my-pi/blob/v18.12.2/packages/coding-agent/src/extensibility/extensions/loader.ts) owns this parsed map. If its shape is unavailable, or it contains an extension value for a built-in name used by the launch, refuse controlled restart before shutdown. Same-type collisions are rejected too: value type alone does not prove identical parsing or path semantics.

The map contains values, not every registration: unused flags without defaults are absent. Do not treat absence as proof that a flag name is unregistered. The wrapper loads its adapter with `-e` (or an inline trusted-extension option), resumes through OMP's `-r` alias, and sets the child's actual process cwd after removing the original cwd selector. Short options are not extension-shadowable in the verified host parser. Reject incomplete or flag-looking spaced string values; inline values keep consumption explicit without changing normal spaced options such as `--model MODEL`.

This is a private metadata dependency, not a supported host API. Lifecycle actions still use public `ctx.shutdown()`. Remove the guard when OMP supplies public parsed-flag metadata or owns restart argument selection; do not extend the exception to other internals.

`ompi` is an additive native wrapper, not a replacement OMP runtime. Standard commands and arguments pass to the installed `omp`; the reserved `control` namespace provides additional control and recovery interfaces, while `/ompi` exposes them directly inside OMP. The JavaScript adapter remains host-loaded package data. Temporary relaunch/argv, adapter, and discovery responsibilities have separate [upstream removal criteria](README.md#temporary-ownership-and-upstream-removal). Remove each when the corresponding supported OMP contract preserves its invariants; remove the wrapper entirely when standard OMP covers the complete outcome.

## Platform Scope

Linux, including Ubuntu, is the only supported platform. Future macOS/Windows implementations must introduce their own concrete platform boundary and focused checks; no speculative adapters or scattered shared-code platform branches are included.
