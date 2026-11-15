# tamperproof on OpenAI Codex CLI

Since 0.2.0 the same hook scripts guard Codex CLI as well as Claude Code. Checked against
codex-cli 0.167.0-alpha.4.1 on Windows 11.

## Install

From a clone of this repo:

```
node plugins/tamperproof/codex/install.mjs                 # this repo:  <git root>/.codex/hooks.json
node plugins/tamperproof/codex/install.mjs --global        # every repo: $CODEX_HOME/hooks.json (~/.codex)
node plugins/tamperproof/codex/install.mjs --project PATH  # some other repo
node plugins/tamperproof/codex/install.mjs --print         # print the hooks JSON, write nothing
node plugins/tamperproof/codex/install.mjs --uninstall     # remove tamperproof's entries again
```

The installer keeps any hooks already in the file and replaces only earlier tamperproof entries, so running it
again after moving the clone is safe. The hooks point at the scripts by absolute path, so keep the clone where it is.

Codex skips new or changed hooks until you trust them. Open Codex in the repo and run `/hooks` once to review and
trust them. Project-level hooks (`<repo>/.codex/hooks.json`) also need the project itself to be trusted.

## What runs where

| Codex event | Matcher | Script | What it does |
| --- | --- | --- | --- |
| `PreToolUse` | `Bash\|apply_patch` | `guard.mjs` | Parses every file in an `apply_patch` payload and blocks edits, deletes and renames of existing protected files (and adds that would overwrite one). Checks shell commands with the same allowlist as Claude Code. Takes a content snapshot of every protected file before an allowed shell command. |
| `PostToolUse` | `Bash` | `guard.mjs` | Compares protected files against that snapshot, after successful and failed commands alike. Anything a command changed or deleted is restored and the agent is told; changes made through git (checkout, pull, merge, rebase, stash) or by a formatter-only command are left alone and reported. |
| `Stop` | none | `verify.mjs` | Reports protected files changed since the session's first shell command (once, without reverting), then runs your test command and keeps the agent working while it fails, up to `maxBlocks` times. |

`.tamperproof.json`, the default protect list and `TAMPERPROOF_OFF=1` work the same as in Claude Code.

## Things that differ from Claude Code

- **How a hook says no.** codex-cli 0.167 reports a hook that exits 2 as *failed* and lets the call go ahead,
  for `apply_patch` and shell alike. tamperproof therefore answers Codex with a JSON decision on stdout and
  exit 0: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}` before a
  tool runs, and `{"decision":"block","reason":...}` after a shell command or at Stop. Claude Code (detected by
  `CLAUDE_PROJECT_DIR` and the absence of `turn_id`) still gets exit 2 with the reason on stderr. Set
  `TAMPERPROOF_HOST=claude` or `TAMPERPROOF_HOST=codex` to force one protocol.
- **Project root.** Codex doesn't set `CLAUDE_PROJECT_DIR`. The hooks use the git toplevel of the session
  `cwd` from the payload, so `.tamperproof.json` is read from the repo root even when Codex runs in a subdirectory.
- **Paths in patches.** Codex sends `apply_patch` paths as absolute paths. Relative paths are resolved
  against the session `cwd`. Paths outside the repo are ignored.
- **PowerShell.** On Windows Codex runs commands through PowerShell. `Set-Content`, `Out-File`,
  `Remove-Item`, `Copy-Item` and `Move-Item` count as writers like any unlisted command, and `Get-Content`,
  `Select-String`, `Get-ChildItem` and `Test-Path` are allowed as read-only.

## The snapshot check

Before every allowed shell command `guard.mjs` records every protected file, and after it puts back any that the
command changed or deleted, unless git or a formatter explains the change. Codex runs `PostToolUse` after a
shell command that exits non-zero too (checked live on codex-cli 0.167.0-alpha.4.1), so `node fix.mjs; exit 1`
is reverted like any other command; Codex has no `PostToolUseFailure` event and needs no extra entry.

How it works, what it costs, what it leaves alone and its limits: [snapshot.md](snapshot.md).

## Verifying it yourself

`node --test` runs everything, including `test/codex.test.mjs`, which feeds the hooks payloads in the exact
shapes codex-cli 0.167 sends. To watch it live without trusting hooks permanently, run Codex once with
`--dangerously-bypass-hook-trust` and the hooks passed as `-c hooks.PreToolUse=[...]` overrides (use
`--print` for the JSON to translate).
