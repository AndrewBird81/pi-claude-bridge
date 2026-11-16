# AndrewBird81 fork maintenance

This fork tracks the latest stable release of
[`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)
and carries a small customization stack on top. The tracked release is recorded
in `.upstream-release`; do not use unreleased `upstream/main` as the baseline.

## Fork-only behavior

- `provider.defaultAccountName` and `provider.accounts` register personal/work
  Claude subscriptions as separate Pi providers.
- Each account routes session files, Claude Code subprocesses, model plan
  settings, and thinking replay to its own account. A provider switch imports
  pi's history into a new session under the other account rather than resuming
  a session from another account.
- A redirected Pi agent directory falls back to the default global bridge config
  when it has no local config.

- Hosts that run their own agent loop over the provider (built on pi-durable)
  work without pi's lifecycle events. Until pi's loop reports a live prompt
  (`agent_start`/`turn_start`), the bridge projects the prompt from the
  transcript's named sections; and it reads pi-durable's end-of-request abort
  reason as the request ending, not as an abort. Under pi neither path runs.
  Covered by `tests/unit-durable-host.mjs`.

Upstream owns session sync, the model catalog and every model the fork once
listed ahead of it (Fable 5.2, Haiku 5.5). Fork commits must not duplicate
those or add fork release notes to `CHANGELOG.md`.

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
  (needs the `CONFIG_DIR_NAME` and `homedir` imports).

`src/convert.ts`
- `isBridgeProvider`: the default account's provider id or a named account's.
- `convertPiMessages(..., providerId)` replays thinking signatures minted by
  the account whose session is being imported, not only bare `claude-bridge`.

`src/prompt-capture.ts`
- `PromptCaptures.reportsLivePrompts`, set by `record()` on an `agent_start`
  or `turn_start` source.
- `HARNESS_SECTIONS`, `PI_PREAMBLE` and `captureFromSections` (needs the
  `MCP_TOOL_PREFIX` import).

`src/transcript.ts`
- `currentSystemParts`.

`src/message-digests.ts`
- `isReplayableThinking` uses `isBridgeProvider`, so a named account's signed
  thinking counts in a digest exactly as the default account's does.

`src/session-sync.ts`
- `importHistory(..., providerId)` passes the account to `convertPiMessages`.

`src/session-transcript.ts`
- `readTranscript(state, claudeDir)` reads from the account's config dir.

`src/index.ts`
- `Account`, `defaultAccount`, `accountsById`, `accountFor`, `claudeDirFor`,
  `childEnvFor`, `configureAccounts`. `configureAccounts` absorbs upstream's
  activation-time `longContextSettings` block; the activation body calls it.
  `configureAccounts` needs the `homedir` import. `childEnvFor` sets the
  account's `CLAUDE_CONFIG_DIR` after `ccChildEnv`, which refuses one from a
  caller.
- `syncSharedSession` takes the account: its `statSync`, `createSession`,
  `readTranscript`, `importHistory` and `verifyWrittenSession` calls use the
  account's config dir and provider id. There is no account field in
  `SessionState`: a mirror written under another account's dir reads as
  upstream's missing transcript, which imports pi's history.
- `verifyWrittenSession` takes the config dir for its two diagnostics.
- `runIsolatedSummary` and `streamClaudeAgentSdk` resolve the account from
  `model.provider` and use its plan settings, child env and, for the two
  `deleteSession` calls, its config dir. The default account inherits the
  process `CLAUDE_CONFIG_DIR` exactly as upstream does.
- `consumeQuery`'s two `extraUsageByChoice` checks use the model's account.
- The `tool_call` bash-timeout default applies to every account's provider,
  not only bare `claude-bridge`.
- Activation registers one provider per account through `registerAccount`,
  including the later-instance `session_start` path.
- `__test` exports `configureAccounts`, `accountFor`, `childEnvFor`.
- pi-durable hosts: `streamClaudeAgentSdk` takes `systemParts` before
  `toBridgeContext` and uses `captureFromSections` in place of
  `resolveOrDerive` while `reportsLivePrompts` is false.
- pi-durable hosts: `CALL_ENDED_REASON` and `isCallEnd`; the opening call's
  signal goes through `onOpeningAbort`, which ignores a call end and records
  it in `callEnded` for the completion path's `options.signal.aborted` check.

`src/cache-trace.ts` is untouched: its opt-in snapshots read session files from
the process `CLAUDE_CONFIG_DIR` only.

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
