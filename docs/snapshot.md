# The snapshot check

The command allowlist only sees the command text, so before 0.2.0 a script that rewrote tests without naming
them got through (`node fix.mjs`, a Makefile target, a codegen step). The snapshot check closes that gap for
Claude Code and Codex CLI alike.

## What runs when

| Host | Before an allowed shell command | After it |
| --- | --- | --- |
| Claude Code | `PreToolUse` on `Bash` | `PostToolUse` when the command succeeds, `PostToolUseFailure` when it exits non-zero |
| Codex CLI | `PreToolUse` on `Bash` | `PostToolUse` in both cases (Codex has no failure event) |

Claude Code only runs `PostToolUse` for a tool call that succeeded. Without the `PostToolUseFailure` entry,
`node fix.mjs; exit 1` or `node fix.mjs && npm test` with a failing suite was never checked. Both entries are in
`plugins/tamperproof/hooks/hooks.json`.

1. **Before.** `guard.mjs` records every existing protected file: its content id and its stat signature (size,
   mtime, ctime, inode). Content that only exists in the working tree is copied to
   `$TMPDIR/tamperproof/<project>/blobs/` so it can be put back.
2. **After.** Every protected file whose signature changed is hashed again. Files that changed or vanished are
   sorted into three groups:
   - **Changed through git**: the command moved `HEAD` and the file now matches the new `HEAD` (checkout, pull,
     merge, rebase, `reset --hard <rev>`, cherry-pick), or it matches the stash entry that existed before (stash
     pop/apply), or the command pushed a stash and the file is back at `HEAD` (`git stash`), or a merge/rebase
     stopped on conflicts and the file is unmerged or staged. Left as is; the agent gets a note.
   - **Reformatted**: every part of the command is a known formatter (`prettier --write`, `eslint --fix`,
     `cargo fmt`, `black`, `ruff format`, `gofmt -w`, `go fmt`, `dotnet format`, `rubocop -a` and others; also
     `npm run <script>` when that package.json script is itself a formatter), optionally with `cd`, `echo` or
     `git diff/status`. Left as is; the agent gets a note to check the diff.
   - **Everything else** is restored and the agent is told it can't change tests through scripts.
     `prettier --write . && node fix.mjs` and `node fix.mjs && git commit --allow-empty -m x` land here: only the
     part of a change that git or a formatter accounts for is left alone.
3. **Stop.** Before running the tests, `verify.mjs` compares protected files with the session's first snapshot
   and lists anything that changed by any route. This is reported once and not reverted, because by then a change
   may be the user's own edit. The agent can't restore tests itself (the guard blocks those commands too), so the
   report gives a restore command per file for the user: `git checkout -- "<file>"` when the index still holds the
   old version, `git cat-file --filters --path="<file>" <id> > "<file>"` when only git's object store does, and
   `cp "<backup>" "<file>"` for files git never had.

New files in protected folders are always left alone: adding tests is fine.

## Cost

Measured on Windows 11 with a repo holding 4,000 tracked test files and 200 MB of tracked `testdata/`
(PreToolUse + PostToolUse of `guard.mjs` for `ls`, `CLAUDE_PROJECT_DIR` set):

| | first call | later calls | backup store |
| --- | --- | --- | --- |
| 0.2.0 as first written | 10.3 s + 0.65 s | 1.3 s + 0.6 s | 202 MB |
| now | 0.58 s + 0.33 s | 0.59 s + 0.33 s | 0 MB |
| now, `testdata/` untracked | 1.85 s + 0.33 s | 0.57 s + 0.28 s | 200 MB |

Why it is cheap:

- A tracked file that `git diff-files` reports clean has the index blob as its content id. It is not read, and
  not copied, because git's object store already has it. A restore from git uses `git cat-file --filters`
  (as `git checkout` would write it), or the unfiltered blob when that matches the file's recorded size (an LF
  file written by a tool in an `autocrlf` repo).
- Stat signatures are cached per project in `statcache.json`. A file whose signature did not change is not
  read again. ctime is part of the signature because a script can put mtime back (`utimes`) but not ctime.
- Only untracked or locally modified protected files are hashed (`git hash-object --stdin-paths`, so `autocrlf`
  and other clean filters line up with the index) and copied. Outside git, content ids are SHA-256 of the bytes,
  with the same stat cache.

## Timeouts and failing closed

The hook timeout is 60 s in `hooks.json` and in the Codex installer. A snapshot that cannot be taken, because it
runs past `snapshotBudgetMs` (default 30,000) or the state directory can't be written, **blocks the command** and
tells the agent why, instead of letting the host kill the hook and silently skipping the check. To trade the
check for speed on a huge repo, narrow `protect` or set `"snapshot": false` in `.tamperproof.json`. The command
allowlist and the Stop report keep running.

## State on disk

Everything lives in `$TMPDIR/tamperproof/<project>/` (move it with `TAMPERPROOF_STATE_DIR`):

- `pre/<session>-<call>.json`: the snapshot for one command, deleted by its post-check.
- `sessions/<session>.json`: the session baseline for the Stop report.
- `blobs/<id>`: backups of working-tree-only content.
- `statcache.json`: stat signatures and content ids.

The Stop hook prunes it. It deletes this session's leftover per-call snapshots (a post-check that never ran, e.g.
after an interrupt), any per-call snapshot older than a day, baselines older than a week, and backups that no
remaining snapshot or baseline points at once they are an hour old. Backups named in a Stop report's restore
commands stay referenced until that baseline expires.

## Limits

- **Background commands.** With Claude Code's `run_in_background`, `PostToolUse` fires when the command
  starts, so whatever a backgrounded `node fix.mjs` writes later is not reverted. The Stop report lists it, with
  restore commands for the user.
- **Interrupted commands.** If no post event arrives at all, that command's changes are not reverted. The Stop
  report lists them.
- **Changes git accounts for are trusted.** `node fix.mjs && git commit -qam x` commits the rewritten test, and
  the new `HEAD` explains the change, so it is left alone. It is in git history, and the Stop report lists it.
- **`git reset --hard` / `git checkout .` with uncommitted test edits** puts those edits back, since `HEAD`
  did not move and nothing kept a copy. Use `git stash` to set test edits aside.
- **Path checkouts** such as `git checkout <rev> .` are reverted in the working tree (the same as
  `git checkout <rev> -- test/x`, which the allowlist blocks). The index keeps what git staged.
- **Formatters are trusted by name.** A formatter configured to rewrite assertions would get through. The note
  tells the agent to check the diff, and the Stop report lists the file.
- A change made and undone within one command is invisible. If you edit a test by hand while a long-running agent
  command is executing, the post-command check puts the old version back and says so.
