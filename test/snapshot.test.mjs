// The post-command snapshot check in depth: failed commands (Claude Code's PostToolUseFailure), git operations
// and formatters that legitimately rewrite tests, the stat cache, failing closed, the Stop report's restore
// commands, and pruning of hook state. Runs the real hook scripts against throwaway git repos.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { formatterOnly } from "../plugins/tamperproof/hooks/rules.mjs";
import { diffSnapshot, prune, takeSnapshot } from "../plugins/tamperproof/hooks/snapshot.mjs";
import { compileProtect, DEFAULT_PROTECT } from "../plugins/tamperproof/hooks/config.mjs";

const HOOKS = join(import.meta.dirname, "..", "plugins", "tamperproof", "hooks");
const STATE = mkdtempSync(join(tmpdir(), "tp-state-"));
const A = "export const a = 1; // test v1\n";
const A_FEATURE = "export const a = 1; // test v2, from the feature branch\n";
const GUTTED = "// gutted\n";
const gitc = (cwd, cmd) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, stdio: "pipe", encoding: "utf8" });

// autocrlf is pinned off so expected bytes are the same on every machine; the autocrlf test turns it on.
function makeRepo({ autocrlf = "false" } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "tp-snap-"));
  mkdirSync(join(repo, "src")); mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "src", "a.mjs"), "export const a = 1;\n");
  writeFileSync(join(repo, "test", "a.test.mjs"), A);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node -e 0", format: "prettier --write .", sneaky: "node fix.mjs" } }) + "\n");
  writeFileSync(join(repo, "fix.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("test/a.test.mjs", ${JSON.stringify(GUTTED)});\n`);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  execSync("git init -q -b main", { cwd: repo });
  execSync(`git config core.autocrlf ${autocrlf}`, { cwd: repo });
  gitc(repo, "add -A"); gitc(repo, "commit -qm init");
  gitc(repo, "checkout -q -b feature");
  writeFileSync(join(repo, "test", "a.test.mjs"), A_FEATURE);
  gitc(repo, "commit -qam feature-changes-test");
  gitc(repo, "checkout -q main");
  return repo;
}
const repo = makeRepo();
const read = (p, r = repo) => readFileSync(join(r, p), "utf8");

const baseEnv = (({ NODE_TEST_CONTEXT, CLAUDE_PROJECT_DIR, ...rest }) => ({ ...rest, TAMPERPROOF_STATE_DIR: STATE }))(process.env);
// Claude Code: CLAUDE_PROJECT_DIR set, no turn_id, refusals are exit 2 + stderr, notes are JSON on stdout.
function hook(name, input, { r = repo, env = {} } = {}) {
  const res = spawnSync("node", [join(HOOKS, name)], { input: JSON.stringify(input), encoding: "utf8", env: { ...baseEnv, CLAUDE_PROJECT_DIR: r, ...env } });
  let json = null;
  try { json = res.stdout.trim() ? JSON.parse(res.stdout) : null; } catch { /* not JSON */ }
  return { ...res, json, context: json?.hookSpecificOutput?.additionalContext ?? "" };
}
let n = 0;
const bashPayload = (command, extra = {}) => ({ session_id: "s-main", tool_use_id: `toolu_${++n}`, cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
// PreToolUse, then the command for real, then PostToolUse (or PostToolUseFailure when it exits non-zero), the
// way Claude Code 2.1 runs them.
function roundTrip(command, { r = repo, simulate, extra = {}, env = {} } = {}) {
  const pre = bashPayload(command, { cwd: r, ...extra });
  const p = hook("guard.mjs", pre, { r, env });
  if (p.status !== 0) return { pre: p };
  let ok = true;
  if (simulate) simulate(); else { try { execSync(command, { cwd: r, stdio: "ignore", shell: "bash" }); } catch { ok = false; } }
  const post = hook("guard.mjs", ok
    ? { ...pre, hook_event_name: "PostToolUse", tool_response: {} }
    : { ...pre, hook_event_name: "PostToolUseFailure", error: "Exit code 1", is_interrupt: false }, { r, env });
  return { pre: p, post, failed: !ok };
}

// --- failed commands ---------------------------------------------------------------------------------
test("hooks.json runs the post-check on PostToolUseFailure too (Claude Code skips PostToolUse when a command fails)", () => {
  const cfg = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8")).hooks;
  for (const ev of ["PostToolUse", "PostToolUseFailure"]) {
    assert.equal(cfg[ev][0].matcher, "Bash", ev);
    assert.match(cfg[ev][0].hooks[0].command, /guard\.mjs/, ev);
  }
});
test("a script that rewrites a test and exits non-zero is reverted (PostToolUseFailure)", () => {
  const r = roundTrip("node fix.mjs; exit 1");
  assert.equal(r.failed, true, "the command itself failed");
  assert.equal(r.post.status, 2);
  assert.match(r.post.stderr, /`node fix\.mjs; exit 1` changed protected test files.*\n.*modified test\/a\.test\.mjs \(restored\)/);
  assert.equal(read("test/a.test.mjs"), A);
});
test("`node fix.mjs && false` style chains are reverted too", () => {
  const r = roundTrip("node fix.mjs && false");
  assert.equal(r.post.status, 2);
  assert.equal(read("test/a.test.mjs"), A);
});

// --- git operations are not reverted -----------------------------------------------------------------
test("git checkout of a branch that changes a test is left alone", () => {
  const r = roundTrip("git checkout -q feature");
  assert.equal(r.post.status, 0, r.post.stderr);
  assert.match(r.post.context, /changed through git.*\n.*modified test\/a\.test\.mjs \(left as is\)/is);
  assert.equal(read("test/a.test.mjs"), A_FEATURE);
  assert.equal(gitc(repo, "status --porcelain"), "", "working tree matches the branch");
  assert.equal(roundTrip("git checkout -q main").post.status, 0);
  assert.equal(read("test/a.test.mjs"), A);
});
test("git merge (fast-forward) and git reset --hard <rev> are left alone", () => {
  gitc(repo, "checkout -q -b scratch");
  assert.equal(roundTrip("git merge -q --ff-only feature").post.status, 0);
  assert.equal(read("test/a.test.mjs"), A_FEATURE);
  assert.equal(roundTrip("git reset -q --hard main").post.status, 0);
  assert.equal(read("test/a.test.mjs"), A);
  gitc(repo, "checkout -q main"); gitc(repo, "branch -q -D scratch");
});
test("git stash and git stash pop of an uncommitted test edit are left alone", () => {
  writeFileSync(join(repo, "test", "a.test.mjs"), A + "// user's work in progress\n");
  assert.equal(roundTrip("git stash -q").post.status, 0);
  assert.equal(read("test/a.test.mjs"), A);
  assert.equal(roundTrip("git stash pop -q").post.status, 0);
  assert.equal(read("test/a.test.mjs"), A + "// user's work in progress\n");
  gitc(repo, "checkout -- test/a.test.mjs");
});
test("a script write followed by an unrelated git command is still reverted", () => {
  const r = roundTrip("node fix.mjs && git commit -q --allow-empty -m noise");
  assert.equal(r.post.status, 2);
  assert.equal(read("test/a.test.mjs"), A);
  gitc(repo, "reset -q --hard HEAD~1");
});

test("documented limit: a rewrite that is committed in the same command is left, and the Stop report lists it", () => {
  const r9 = makeRepo();
  const sid = "s-commit";
  const r = roundTrip("node fix.mjs && git -c user.email=t@t -c user.name=t commit -qam cheat", { r: r9, extra: { session_id: sid } });
  assert.equal(r.post.status, 0);
  assert.equal(read("test/a.test.mjs", r9), GUTTED);
  const stop = hook("verify.mjs", { session_id: sid, cwd: r9, hook_event_name: "Stop" }, { r: r9 });
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /modified test\/a\.test\.mjs/);
});

// --- formatters are reported, not reverted -----------------------------------------------------------
test("formatterOnly: whole command must be formatters (plus cd/echo/git status)", () => {
  for (const c of ["prettier --write .", "npx prettier --write test", "cargo fmt", "cargo +nightly fmt --all", "black .", "ruff format", "ruff check --fix .",
    "gofmt -w .", "go fmt ./...", "eslint --fix src test", "npx eslint . --fix", "cd web && npm run format", "dotnet format", "cargo fmt && git diff --stat"]) {
    assert.equal(formatterOnly(c, { format: "prettier --write ." }), true, c);
  }
  for (const c of ["prettier --write . && node fix.mjs", "node fix.mjs", "prettier --check .", "eslint .", "npm run sneaky", "npm run format && npm test", "black . > out.txt", "cd test", ""]) {
    assert.equal(formatterOnly(c, { format: "prettier --write .", sneaky: "node fix.mjs" }), false, c);
  }
});
test("a formatter rewriting a test is reported and left as is", () => {
  const r = roundTrip("npx prettier --write test", { simulate: () => writeFileSync(join(repo, "test", "a.test.mjs"), A.replace("1;", "1 ;")) });
  assert.equal(r.post.status, 0, r.post.stderr);
  assert.match(r.post.context, /Reformatted by a formatter.*\n.*modified test\/a\.test\.mjs \(left as is\)/s);
  assert.equal(read("test/a.test.mjs"), A.replace("1;", "1 ;"));
  gitc(repo, "checkout -- test/a.test.mjs");
});
test("`npm run format` counts as a formatter when its package.json script is one", () => {
  const r = roundTrip("npm run format", { simulate: () => writeFileSync(join(repo, "test", "a.test.mjs"), A.replace("1;", "1 ;")) });
  assert.equal(r.post.status, 0, r.post.stderr);
  gitc(repo, "checkout -- test/a.test.mjs");
});
test("a formatter chained with a script is not a formatter: reverted", () => {
  const r = roundTrip("prettier --write . && node fix.mjs", { simulate: () => execSync("node fix.mjs", { cwd: repo }) });
  assert.equal(r.post.status, 2);
  assert.equal(read("test/a.test.mjs"), A);
});
test("`npm run sneaky` (a script that runs fix.mjs) is not a formatter: reverted", () => {
  const r = roundTrip("npm run sneaky", { simulate: () => execSync("node fix.mjs", { cwd: repo }) });
  assert.equal(r.post.status, 2);
  assert.equal(read("test/a.test.mjs"), A);
});

// --- cost: stat cache and git index ------------------------------------------------------------------
test("snapshot reads no clean tracked file, and only changed files on later calls", () => {
  const r2 = makeRepo();
  for (let i = 0; i < 300; i++) writeFileSync(join(r2, "test", `t${i}.test.mjs`), `// ${i}\n`);
  gitc(r2, "add -A"); gitc(r2, "commit -qm many");
  const blobs = mkdtempSync(join(tmpdir(), "tp-blobs-")) + "/blobs";
  const isP = compileProtect(DEFAULT_PROTECT);
  const s1 = takeSnapshot(r2, isP, blobs);
  assert.equal(s1.stats.hashed, 0, "clean tracked files come from the index");
  assert.equal(readdirSync(blobs).length, 0, "and need no backup copy: git has them");
  writeFileSync(join(r2, "test", "t7.test.mjs"), "// edited by the user\n");
  writeFileSync(join(r2, "test", "new.test.mjs"), "// untracked\n");
  const s2 = takeSnapshot(r2, isP, blobs);
  assert.equal(s2.stats.hashed, 2, "only the modified and the untracked file are read");
  assert.equal(readdirSync(blobs).length, 2, "and only they are backed up");
  assert.equal(takeSnapshot(r2, isP, blobs).stats.hashed, 0, "third call: everything from the stat cache");
});
test("a same-size rewrite with mtime put back is still caught (ctime is in the signature)", () => {
  const r3 = makeRepo();
  const blobs = mkdtempSync(join(tmpdir(), "tp-blobs-")) + "/blobs";
  const s = takeSnapshot(r3, compileProtect(DEFAULT_PROTECT), blobs);
  const p = join(r3, "test", "a.test.mjs");
  const st = statSync(p);
  const evil = A.replace("v1", "XX");
  assert.equal(evil.length, A.length);
  spawnSync("node", ["-e", "setTimeout(()=>{},50)"]);
  writeFileSync(p, evil);
  utimesSync(p, st.atime, st.mtime);
  const changes = diffSnapshot(r3, s.files, blobs);
  assert.deepStrictEqual(changes.map((c) => [c.rel, c.kind]), [["test/a.test.mjs", "modified"]]);
});
test("with core.autocrlf=true, a restore from git gives back the exact bytes, CRLF or LF", () => {
  const r8 = makeRepo({ autocrlf: "true" });
  const CRLF = A.replace(/\n/g, "\r\n");
  assert.equal(read("test/a.test.mjs", r8), CRLF, "git checked it out with CRLF");
  writeFileSync(join(r8, "test", "lf.test.mjs"), "// LF, written by a tool\n");
  gitc(r8, "add -A"); gitc(r8, "commit -qm lf");
  writeFileSync(join(r8, "test", "lf.test.mjs"), "// LF, written by a tool\n"); // keep it LF on disk
  writeFileSync(join(r8, "fix2.mjs"), 'import { writeFileSync } from "node:fs"; for (const f of ["test/a.test.mjs", "test/lf.test.mjs"]) writeFileSync(f, "x");\n');
  const r = roundTrip("node fix2.mjs", { r: r8, extra: { session_id: "s-crlf" } });
  assert.equal(r.post.status, 2);
  assert.equal(read("test/a.test.mjs", r8), CRLF);
  assert.equal(read("test/lf.test.mjs", r8), "// LF, written by a tool\n");
});

// --- failing closed ----------------------------------------------------------------------------------
test("if the snapshot can't be taken, the command is refused with the reason (not silently unchecked)", () => {
  const notADir = join(mkdtempSync(join(tmpdir(), "tp-x-")), "file");
  writeFileSync(notADir, "x");
  const r = hook("guard.mjs", bashPayload("node fix.mjs"), { env: { TAMPERPROOF_STATE_DIR: notADir } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not snapshot the protected test files/);
  assert.match(r.stderr, /"snapshot": false/);
});
test("a snapshot over its time budget is refused, and `snapshot: false` turns the check off", () => {
  const r4 = makeRepo();
  writeFileSync(join(r4, ".tamperproof.json"), JSON.stringify({ snapshotBudgetMs: 1 }));
  const r = hook("guard.mjs", bashPayload("ls", { cwd: r4 }), { r: r4 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /took over 1 ms/);
  writeFileSync(join(r4, ".tamperproof.json"), JSON.stringify({ snapshot: false }));
  assert.equal(hook("guard.mjs", bashPayload("ls", { cwd: r4 }), { r: r4 }).status, 0);
});

// --- Stop report and pruning -------------------------------------------------------------------------
const projDir = (r) => join(STATE, createHash("sha256").update(execSync("node -e \"process.stdout.write(require('fs').realpathSync.native(process.argv[1]))\" " + JSON.stringify(r)).toString().toLowerCase()).digest("hex").slice(0, 16));
test("Stop report gives restore commands for the user that actually work, and doesn't tell the agent to run blocked ones", () => {
  const r5 = makeRepo();
  const sid = "s-stop";
  assert.equal(hook("guard.mjs", bashPayload("ls", { cwd: r5, session_id: sid }), { r: r5 }).status, 0);
  writeFileSync(join(r5, "test", "a.test.mjs"), GUTTED); // a route no per-command check saw
  const stop = hook("verify.mjs", { session_id: sid, cwd: r5, hook_event_name: "Stop" }, { r: r5 });
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /modified test\/a\.test\.mjs\n\s+to restore: git checkout -- "test\/a\.test\.mjs"/);
  assert.match(stop.stderr, /Don't try to put them back yourself/);
  assert.doesNotMatch(stop.stderr, /put them back \(`git checkout/);
  const cmd = stop.stderr.match(/to restore: (.+)/)[1];
  execSync(cmd, { cwd: r5, shell: "bash" });
  assert.equal(read("test/a.test.mjs", r5), A);
});
test("Stop restore command for an untracked test points at the backup copy", () => {
  const r6 = makeRepo();
  const sid = "s-stop-2";
  writeFileSync(join(r6, "test", "b.test.mjs"), "// untracked test\n");
  assert.equal(hook("guard.mjs", bashPayload("ls", { cwd: r6, session_id: sid }), { r: r6 }).status, 0);
  rmSync(join(r6, "test", "b.test.mjs"));
  const stop = hook("verify.mjs", { session_id: sid, cwd: r6, hook_event_name: "Stop" }, { r: r6 });
  assert.equal(stop.status, 2);
  const cmd = stop.stderr.match(/to restore: (cp .+)/)[1];
  execSync(cmd, { cwd: r6, shell: "bash" });
  assert.equal(read("test/b.test.mjs", r6), "// untracked test\n");
});
test("Stop prunes this session's leftover snapshots and old unreferenced backups", () => {
  const r7 = makeRepo();
  const sid = "s-prune";
  writeFileSync(join(r7, "test", "c.test.mjs"), "// untracked, backed up\n");
  assert.equal(hook("guard.mjs", bashPayload("ls", { cwd: r7, session_id: sid, tool_use_id: "never-posted" }), { r: r7 }).status, 0);
  const proj = projDir(r7);
  assert.ok(existsSync(join(proj, "pre", `${sid}-never-posted.json`)), "a post-check that never ran leaves a snapshot");
  const blobs = join(proj, "blobs");
  const referenced = readdirSync(blobs);
  assert.equal(referenced.length, 1);
  const stale = join(blobs, "0".repeat(40));
  writeFileSync(stale, "old version nobody points at");
  const old = new Date(Date.now() - 2 * 3600_000);
  utimesSync(stale, old, old);
  for (const f of referenced) utimesSync(join(blobs, f), old, old);
  assert.equal(hook("verify.mjs", { session_id: sid, cwd: r7, hook_event_name: "Stop" }, { r: r7 }).status, 0);
  assert.ok(!existsSync(join(proj, "pre", `${sid}-never-posted.json`)), "leftover snapshot removed");
  assert.ok(!existsSync(stale), "unreferenced old backup removed");
  for (const f of referenced) assert.ok(existsSync(join(blobs, f)), "backup the session baseline needs is kept");
});
test("prune drops snapshots older than a day and baselines older than a week", () => {
  const proj = mkdtempSync(join(tmpdir(), "tp-proj-"));
  for (const d of ["pre", "sessions", "blobs"]) mkdirSync(join(proj, d));
  writeFileSync(join(proj, "pre", "other-1.json"), "{}");
  writeFileSync(join(proj, "sessions", "old.json"), "{}");
  writeFileSync(join(proj, "sessions", "fresh.json"), JSON.stringify({ files: { "t.js": { h: "abc" } } }));
  writeFileSync(join(proj, "blobs", "abc"), "kept");
  const now = Date.now();
  const days = (d) => new Date(now - d * 86400_000);
  utimesSync(join(proj, "pre", "other-1.json"), days(2), days(2));
  utimesSync(join(proj, "sessions", "old.json"), days(8), days(8));
  utimesSync(join(proj, "blobs", "abc"), days(3), days(3));
  assert.deepStrictEqual(prune(proj, "someone-else", now), { pre: 1, sessions: 1, blobs: 0 });
  assert.ok(existsSync(join(proj, "blobs", "abc")));
});
