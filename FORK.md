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

## Source ledger

Every hunk in `git diff $(cat .upstream-release)..HEAD -- src/` must appear
here. A hunk that is not explained by this list is a rebase mistake: the fork
once reinstated pre-release upstream code by resolving conflicts "keep ours",
which silently reverted upstream's `/bug` summarizer routing. When a rebase
conflicts, re-derive the fork side against the new upstream text; never keep
the fork's copy of surrounding upstream lines.

`src/config.ts`
- `provider.defaultAccountName` and `provider.accounts` in `Config`.
- `globalConfigPath()` falls back to `~/.pi/agent/claude-bridge.json`
  (needs the `homedir` import).

`src/convert.ts`
- `convertPiMessages(..., providerId)` replays thinking signatures minted by
  the account whose session is being rebuilt, not only bare `claude-bridge`.

`src/index.ts`
- `Account`, `defaultAccount`, `accountsById`, `accountFor`, `claudeDirFor`,
  `childEnvFor`, `configureAccounts`. `configureAccounts` absorbs upstream's
  activation-time `longContextSettings` block; the activation body calls it.
- `SessionState.providerId` records which account owns the shared session.
- `readCarriedAttachments`, `verifyWrittenSession`, `deleteSession` and
  `createSession` callers take the account's config dir instead of
  `process.env.CLAUDE_CONFIG_DIR`.
- `convertAndImportMessages` and `syncSharedSession` take the account;
  `sessionAccountMatches` forces a rebuild on a provider switch.
- `runIsolatedSummary` and `streamClaudeAgentSdk` resolve the account from
  `model.provider` and use its plan settings and child env. The default
  account inherits the process `CLAUDE_CONFIG_DIR` exactly as upstream does.
- `promptAndWait` (AskClaude) pins the default account and never resumes a
  session owned by another account.
- Activation registers one provider per account through `registerAccount`,
  including the later-instance `session_start` path.
- `__test` exports `configureAccounts`, `accountFor`, `childEnvFor`.

Anything else under `src/` is upstream and must be byte-identical to the
tracked release.

## Synchronize a new stable release

```sh
./scripts/sync-upstream
```

Run it from a clean `main`. The command fetches release tags into an
upstream-only namespace, identifies the newest stable `v*` tag, preserves the
source tip with a local archive tag, creates a synchronization branch, and
replays the linear customization commits onto the release. It verifies the
recorded baseline is an ancestor and stops on conflicts. Resolve semantic
conflicts manually, run the full checks, and review the release-to-`HEAD` diff
before publishing. It never pushes, rewrites `main`, updates nix-config, or
deploys.

The fork's `upstream` remote has a disabled push URL. Push the archive tag and
then the reviewed branch only to `origin`, using `--force-with-lease` when
deliberately replacing the pinned `main` history.
