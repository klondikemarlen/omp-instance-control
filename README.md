# OMP Instance Control

Linux-first OMP plugin project for requesting safe restart and plugin reload across participating terminal instances from another OMP instance or an external process.

## Project Status

Repository setup only. There is no loadable plugin, executable client, or runtime implementation yet. Nothing is published or installed.

The initial platform target is **Linux**. macOS and Windows may be added later; neither is currently supported or promised.

## Intended Behavior

- Expose a private local control endpoint in each participating main interactive OMP instance.
- Allow an external client or another OMP instance to target one instance or broadcast to an explicitly selected group.
- Defer lifecycle actions until the session settles, without interrupting provider requests, tools, queued prompts, or background work that can wake the agent.
- Restart in the same terminal and resume the persisted conversation; do not replay the original startup prompt.
- Distinguish plugin resource refresh from process restart. Updated extension code requires fresh module loading, not merely resource discovery.
- Report accepted, deferred, completed, unreachable, and failed outcomes truthfully.

## Upstream Feature

Track [can1357/oh-my-pi#6458: Global Config and Plugin Reload Across Running Sessions](https://github.com/can1357/oh-my-pi/issues/6458), including its graceful restart/resume discussion.

On OMP 18.8.7, native `/restart` and `/reload-plugins` exist, but the public extension context does not expose equivalent restart or plugin-refresh requests. `ctx.shutdown()` requests graceful shutdown; command-context `ctx.reload()` reloads the session transcript, not plugins. Public settled-boundary lifecycle APIs are the preferred integration path. This repository must not pretend that those APIs already exist.

See [CONCEPTS.md](CONCEPTS.md) for the boundary, evidence, and unresolved host dependency.

## Repository Layout

The integration-oriented organization follows [omp-send-context](https://github.com/klondikemarlen/omp-send-context):

- [`omp/`](omp/README.md): OMP lifecycle integration and extension ownership.
- [`cli/`](cli/README.md): external client, instance selection, and broadcast reporting.
- [`protocol/`](protocol/README.md): shared request, response, and instance identity contract.
- [`linux/`](linux/README.md): Linux socket transport, permissions, and local discovery.
- `test/<integration>/`: add behavior tests beside the first real implementation; no empty test directories are created now.

Keep Linux-specific filesystem, process, and transport operations inside `linux/`. Shared protocol and client behavior must not depend on Linux paths or scattered operating-system checks. Add other platform directories only when their implementations are in scope.

## Development

Read [AGENTS.md](AGENTS.md) before changing the repository. Use issue-named branches, linked pull requests, complete self-review, focused QA, and merge commits.

Check the current documentation and formatting configuration with:

```bash
npx --yes prettier@3.9.6 --check '**/*.md' .prettierrc.yaml
git diff --check
```

No build, runtime test, release, or installation command is defined until the corresponding implementation exists.
