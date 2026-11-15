# Changelog

## 0.2.0 (2026-11-14)

### Added

- **OpenAI Codex CLI support.** The same hooks now guard Codex sessions (checked against codex-cli
  0.167.0-alpha.4.1). Install with `node plugins/tamperproof/codex/install.mjs`. See `docs/codex.md`.
  - `apply_patch`: every file in the patch is parsed. Edits, deletes and renames of existing protected files
    are blocked, and so are adds that would overwrite one or moves onto one. New test files are still allowed.
  - Shell commands (`Bash`/`exec_command`, string or argv form) go through the same allowlist as Claude Code.
    PowerShell cmdlets are covered, and so are patches piped through `apply_patch <<EOF`.
  - The `Stop` gate runs the real tests before Codex may finish.
- **Snapshot check for script writes.** Before every allowed shell command, every protected file is recorded.
  After it, any protected file the command changed or deleted is restored and the agent is told. This closes the
  known gap where `node fix.mjs` (or any script, Makefile target or codegen step) rewrote tests without naming
  them on the command line. Details, costs and limits: `docs/snapshot.md`.
  - Runs after failed commands too. Claude Code only fires `PostToolUse` when a command succeeds, so
    `hooks.json` also registers `PostToolUseFailure` on `Bash` (checked live on Claude Code 2.1.325:
    `node fix.mjs` that rewrites a test and exits 1 is reverted). Codex fires `PostToolUse` either way (checked
    live on codex-cli 0.167.0-alpha.4.1), so its install entries are unchanged.
  - Git operations and formatters are not reverted. A change is left alone, with a note to the agent, when the
    command moved `HEAD` and the file matches the new `HEAD` (checkout, pull, merge, rebase, reset to a rev,
    cherry-pick), when it matches a pre-existing stash (stash pop/apply) or `HEAD` after a stash push, when a
    merge or rebase stopped on conflicts, or when every part of the command is a known formatter (`prettier
    --write`, `eslint --fix`, `cargo fmt`, `black`, `gofmt -w`, `npm run format` when that script is a formatter,
    and others). `prettier --write . && node fix.mjs` and `node fix.mjs && git commit --allow-empty` are still
    reverted.
  - Cheap on big repos. Clean tracked files take their content id from the git index and are neither read nor
    copied. Stat signatures (size, mtime, ctime, inode) are cached so unchanged files are never re-read. Only
    untracked or modified protected files are hashed and backed up. On 4,000 tracked test files plus 200 MB of
    tracked testdata, the first call went from 10.3 s to 0.58 s and the backup store from 202 MB to 0 MB.
  - Fails closed. If the snapshot can't be taken (over `snapshotBudgetMs`, default 30 s, or the state directory
    can't be written), the command is blocked with the reason instead of the host killing the hook and the check
    silently not running. `"snapshot": false` in `.tamperproof.json` turns the check off. Hook timeouts are 60 s.
- **Stop-time tamper report.** Before running the tests, the `Stop` gate lists protected files that changed
  since the session's first shell command, whatever route the change took. They are reported once, not reverted.
  The agent can't restore tests itself (the guard blocks those commands), so each file comes with a restore
  command for the user (`git checkout -- <file>`, `git cat-file --filters ...`, or `cp` from the backup).
- **Hook state is pruned at Stop**: this session's leftover per-call snapshots, per-call snapshots older than a
  day, session baselines older than a week, and backups nothing references.
- `TAMPERPROOF_STATE_DIR` to move hook state (default `$TMPDIR/tamperproof`), and `TAMPERPROOF_HOST` to force
  the Claude Code or Codex reply protocol.

### Changed

- Hooks resolve the project root from `CLAUDE_PROJECT_DIR`, then the git toplevel of the session `cwd`, then
  the `cwd`. Relative paths in tool calls resolve against the session `cwd`, not the project root.
- Refusals for Codex are JSON decisions on stdout with exit 0, because codex-cli 0.167 treats exit 2 as a failed
  hook and runs the call anyway. Claude Code still gets exit 2 with the reason on stderr.
- The guard logic moved into `hooks/rules.mjs`, `hooks/snapshot.mjs` and `hooks/emit.mjs`. `guard.mjs` and
  `verify.mjs` are thin entry points.

### Tests

- 109 tests (`node --test`): the original 28 Claude Code tests, unchanged, plus 59 in `test/codex.test.mjs`
  covering apply_patch parsing and every file-op path, Codex shell payloads, the snapshot revert, the Codex
  reply protocol, the Stop gate and the installer, plus 22 in `test/snapshot.test.mjs` covering failed
  commands (`PostToolUseFailure`), git checkout/merge/reset/stash, formatters, the stat cache and git-index
  shortcut, CRLF-exact restores, failing closed, the Stop restore commands and pruning.

### Known limits

- A command run with Claude Code's `run_in_background` is checked when it starts, so what it writes later is
  not reverted; the Stop report lists it. A rewrite committed in the same command (`node fix.mjs && git commit
  -am x`) is treated as a git change and left; it is in history and the Stop report lists it.

## 0.1.1

- Allowlist shell guard, fixtures/resources/testdata protected by default, honest stats.

## 0.1.0

- First release: block edits to existing tests, block "done" until the test command passes.
