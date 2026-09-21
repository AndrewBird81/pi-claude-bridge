# AndrewBird81 fork maintenance

This fork tracks the latest stable release of
[`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)
and carries a small customization stack on top. The tracked release is recorded
in `.upstream-release`; do not use unreleased `upstream/main` as the baseline.

## Fork-only behavior

- `provider.defaultAccountName` and `provider.accounts` register personal/work
  Claude subscriptions as separate Pi providers.
- Each account routes session files, Claude Code subprocesses, model plan
  settings, and thinking replay to its own account. A provider switch rebuilds
  the shared session rather than resuming a session from another account.
- A redirected Pi agent directory falls back to the default global bridge config
  when it has no local config.

Upstream owns the Pi 0.86 transcript compatibility, model catalog, and Fable
5.1 support. Fork commits must not duplicate those fixes or add fork release
notes to `CHANGELOG.md`.

## Synchronize a new stable release

```sh
./scripts/sync-upstream
```

The command fetches upstream, identifies the newest stable `v*` tag, creates a
local synchronization branch, and rebases the customization commits onto it.
It refuses a dirty worktree and stops on conflicts. Resolve semantic conflicts
manually, run the full checks, and review the release-to-`HEAD` diff before
publishing. It never pushes, rewrites `main`, updates nix-config, or deploys.

The fork's `upstream` remote has a disabled push URL. Push only to `origin`
after review, using `--force-with-lease` when deliberately replacing the
pinned `main` history. Preserve the old pin with an archive tag first.
