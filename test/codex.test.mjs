// Codex CLI payloads, the snapshot/revert check and the installer. Runs the real hook scripts against a
// throwaway repo, with payload shapes captured from codex-cli 0.167 (tool_name "apply_patch" with the patch
// in tool_input.command and absolute paths; tool_name "Bash" with tool_input.command; no CLAUDE_PROJECT_DIR).
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatch } from "../plugins/tamperproof/hooks/rules.mjs";
import { merge, tamperproofHooks } from "../plugins/tamperproof/codex/install.mjs";

const HOOKS = join(import.meta.dirname, "..", "plugins", "tamperproof", "hooks");
const INSTALL = join(import.meta.dirname, "..", "plugins", "tamperproof", "codex", "install.mjs");
const STATE = mkdtempSync(join(tmpdir(), "tp-state-"));
const repo = mkdtempSync(join(tmpdir(), "tp-codex-"));
const TEST_SRC = 'import { test } from "node:test"; import assert from "node:assert"; import { add } from "../src/calc.mjs"; test("add", () => assert.equal(add(2, 3), 5));\n';
mkdirSync(join(repo, "src")); mkdirSync(join(repo, "test")); mkdirSync(join(repo, "fixtures"));
writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a, b) => a - b;\n");
writeFileSync(join(repo, "test", "calc.test.mjs"), TEST_SRC);
writeFileSync(join(repo, "fixtures", "golden.json"), '{"total": 5}\n');
writeFileSync(join(repo, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });

// Codex does not set CLAUDE_PROJECT_DIR; strip it (and node:test's own context) from the hook's env.
const env = (({ NODE_TEST_CONTEXT, CLAUDE_PROJECT_DIR, ...rest }) => ({ ...rest, TAMPERPROOF_STATE_DIR: STATE }))(process.env);
const rawRun = (name, input, extraEnv = {}) => spawnSync("node", [join(HOOKS, name)], { input: JSON.stringify(input), encoding: "utf8", env: { ...env, ...extraEnv } });
// Codex only honours a JSON decision on stdout (exit 2 counts as a failed hook and the call goes ahead), so a
// Codex refusal must be exit 0 + {"hookSpecificOutput":{"permissionDecision":"deny"}} or {"decision":"block"}.
// Normalise: status 2 = refused (by either protocol), stderr = the reason the agent sees.
function run(name, input, extraEnv) {
  const r = rawRun(name, input, extraEnv);
  if (!r.stdout.trim()) return { ...r, json: null };
  const json = JSON.parse(r.stdout);
  assert.equal(r.status, 0, "JSON decisions must exit 0");
  const deny = json.hookSpecificOutput?.permissionDecision === "deny" || json.decision === "block";
  return { ...r, json, status: deny ? 2 : 0, stderr: json.hookSpecificOutput?.permissionDecisionReason ?? json.reason ?? "" };
}
let n = 0;
const base = (cwd = repo) => ({ session_id: "codex-s1", turn_id: "t1", cwd, model: "gpt", permission_mode: "default", tool_use_id: `call-${++n}` });
const patch = (body, cwd) => ({ ...base(cwd), hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } });
const abs = (p) => join(repo, p).replace(/\\/g, "/");
const read = (p) => readFileSync(join(repo, p), "utf8");

// --- apply_patch ------------------------------------------------------------------------------------
test("parsePatch reads every file op, including moves", () => {
  const ops = parsePatch("*** Begin Patch\n*** Update File: a.js\n@@\n-x\n+y\n*** Move to: b.js\n*** Delete File: c.js\n*** Add File: d.js\n+hi\n*** End Patch");
  assert.deepStrictEqual(ops, [{ op: "update", path: "a.js", moveTo: "b.js" }, { op: "delete", path: "c.js" }, { op: "add", path: "d.js" }]);
});
const patchCases = [
  ["blocks", 2, "editing a test (absolute path, as Codex sends it)", `*** Update File: ${abs("test/calc.test.mjs")}\n@@\n-x\n+y`],
  ["blocks", 2, "editing a test (relative path)", "*** Update File: test/calc.test.mjs\n@@\n-x\n+y"],
  ["blocks", 2, "deleting a test", "*** Delete File: test/calc.test.mjs"],
  ["blocks", 2, "renaming a test", "*** Update File: test/calc.test.mjs\n*** Move to: test/old.test.mjs"],
  ["blocks", 2, "moving source onto an existing test", "*** Update File: src/calc.mjs\n*** Move to: test/calc.test.mjs"],
  ["blocks", 2, "Add File overwriting an existing test", "*** Add File: test/calc.test.mjs\n+empty"],
  ["blocks", 2, "editing a fixture", "*** Update File: fixtures/golden.json\n@@\n-5\n+-1"],
  ["blocks", 2, "a test hidden as the second file of a patch", `*** Update File: ${abs("src/calc.mjs")}\n@@\n-a - b\n+a + b\n*** Update File: ${abs("test/calc.test.mjs")}\n@@\n-5\n+-1`],
  ["blocks", 2, "a patch with CRLF line endings", "*** Update File: test/calc.test.mjs\r\n@@\r\n-x\r\n+y"],
  ["allows", 0, "editing source", `*** Update File: ${abs("src/calc.mjs")}\n@@\n-a - b\n+a + b`],
  ["allows", 0, "adding a brand-new test file", `*** Add File: ${abs("test/extra.test.mjs")}\n+// more tests`],
  ["allows", 0, "renaming source to a new non-test path", "*** Update File: src/calc.mjs\n*** Move to: src/math.mjs"],
  ["allows", 0, "a path outside the repo", "*** Update File: ../elsewhere/test/a.test.mjs\n@@\n-x\n+y"],
];
for (const [verb, code, what, body] of patchCases) test(`apply_patch ${verb} ${what}`, () => assert.equal(run("guard.mjs", patch(body)).status, code));
test("apply_patch resolves relative paths from a subdirectory cwd against the repo root", () => {
  assert.equal(run("guard.mjs", patch("*** Update File: ../test/calc.test.mjs\n@@\n-x\n+y", join(repo, "src"))).status, 2);
  assert.equal(run("guard.mjs", patch("*** Update File: calc.mjs\n@@\n-x\n+y", join(repo, "src"))).status, 0);
});
test("apply_patch block message names the file", () => assert.match(run("guard.mjs", patch("*** Delete File: test/calc.test.mjs")).stderr, /apply_patch deleting test\/calc\.test\.mjs/));

// --- shell commands (exec_command, reported to hooks as Bash) ----------------------------------------
const sh = (command, extra = {}) => ({ ...base(), hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
const shellBlocked = [
  "sed -i s/5/-1/ test/calc.test.mjs", "sed --in-place -e s/5/-1/ test/calc.test.mjs", "perl -pi -e s/5/-1/ test/calc.test.mjs",
  `node -e "require('fs').writeFileSync('test/calc.test.mjs', '')"`, `python -c "open('test/calc.test.mjs','w').write('')"`,
  "echo '' > test/calc.test.mjs", "cat src/calc.mjs > test/calc.test.mjs", "echo x | tee test/calc.test.mjs",
  "rm test/calc.test.mjs", "mv test/calc.test.mjs test/x.mjs", "cp src/calc.mjs test/calc.test.mjs", "mv src/calc.mjs test/calc.test.mjs",
  "git checkout HEAD~1 -- test/calc.test.mjs", "sed -i s/5/-1/ fixtures/golden.json",
  // Codex on Windows runs commands through PowerShell
  "Set-Content test/calc.test.mjs ''", "Remove-Item test/calc.test.mjs", "Copy-Item src/calc.mjs test/calc.test.mjs",
  "Get-Content src/calc.mjs | Set-Content test/calc.test.mjs", "'' | Out-File test/calc.test.mjs",
  // apply_patch smuggled through the shell
  "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: test/calc.test.mjs\n@@\n-5\n+-1\n*** End Patch\nEOF",
];
for (const c of shellBlocked) test(`codex shell blocks: ${c.split("\n")[0]}`, () => assert.equal(run("guard.mjs", sh(c)).status, 2));
const shellAllowed = ["cat test/calc.test.mjs", "npm test", "node --test test/", "Get-Content test/calc.test.mjs", "git diff test/calc.test.mjs", "sed -i s/a/b/ src/calc.mjs", "echo hi > notes.txt"];
for (const c of shellAllowed) test(`codex shell allows: ${c}`, () => {
  const pre = sh(c);
  assert.equal(run("guard.mjs", pre).status, 0);
  assert.equal(run("guard.mjs", { ...pre, hook_event_name: "PostToolUse", tool_response: "" }).status, 0);
});
test("codex shell: argv-array commands are unwrapped", () => assert.equal(run("guard.mjs", { ...sh(""), tool_input: { command: ["bash", "-lc", "sed -i s/5/-1/ test/calc.test.mjs"] } }).status, 2));
test("codex shell: exec_command with a `cmd` field", () => assert.equal(run("guard.mjs", { ...sh(""), tool_name: "exec_command", tool_input: { cmd: "rm fixtures/golden.json" } }).status, 2));

// --- snapshot: scripts that rewrite tests without naming them ----------------------------------------
writeFileSync(join(repo, "fix.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("test/calc.test.mjs", "// gutted\\n");\n`);
writeFileSync(join(repo, "wipe.mjs"), `import { rmSync } from "node:fs"; rmSync("fixtures/golden.json");\n`);
writeFileSync(join(repo, "good.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("src/calc.mjs", "export const add = (a, b) => a + b;\\n");\n`);
writeFileSync(join(repo, "addtest.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync("test/added.test.mjs", "// new\\n");\n`);
// Pre hook, then the command for real, then the Post hook, as Codex and Claude Code do.
function shellRoundTrip(command, extraEnv, payload = {}) {
  const pre = { ...sh(command), ...payload };
  const p = run("guard.mjs", pre, extraEnv);
  if (p.status !== 0) return { pre: p };
  execSync(command, { cwd: repo, stdio: "ignore" });
  return { pre: p, post: run("guard.mjs", { ...pre, hook_event_name: "PostToolUse", tool_response: "" }, extraEnv) };
}
test("snapshot: `node fix.mjs` rewriting a test is blocked and reverted", () => {
  const r = shellRoundTrip("node fix.mjs");
  assert.equal(r.pre.status, 0, "nothing in the command names a test");
  assert.equal(r.post.status, 2);
  assert.match(r.post.stderr, /modified test\/calc\.test\.mjs \(restored\)/);
  assert.equal(read("test/calc.test.mjs"), TEST_SRC);
});
test("snapshot: a script deleting a fixture is blocked and the fixture restored", () => {
  const r = shellRoundTrip("node wipe.mjs");
  assert.equal(r.post.status, 2);
  assert.match(r.post.stderr, /deleted fixtures\/golden\.json \(restored\)/);
  assert.equal(read("fixtures/golden.json"), '{"total": 5}\n');
});
test("snapshot: a script that only edits source passes", () => {
  const r = shellRoundTrip("node good.mjs");
  assert.equal(r.post.status, 0);
  writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a, b) => a - b;\n");
});
test("snapshot: a script adding a new test file passes and keeps it", () => {
  const r = shellRoundTrip("node addtest.mjs");
  assert.equal(r.post.status, 0);
  assert.ok(existsSync(join(repo, "test", "added.test.mjs")));
  rmSync(join(repo, "test", "added.test.mjs"));
});
test("snapshot: works the same under Claude Code (CLAUDE_PROJECT_DIR, Claude payload, exit 2 protocol)", () => {
  const r = shellRoundTrip("node fix.mjs", { CLAUDE_PROJECT_DIR: repo }, { session_id: "claude-s1", tool_use_id: "toolu_1", cwd: repo, turn_id: undefined, model: undefined });
  assert.equal(r.post.status, 2);
  assert.equal(r.post.json, null, "Claude Code gets exit 2 + stderr, not JSON");
  assert.match(r.post.stderr, /modified test\/calc\.test\.mjs \(restored\)/);
  assert.equal(read("test/calc.test.mjs"), TEST_SRC);
});
test("codex protocol: PreToolUse refusal is a JSON deny with exit 0", () => {
  const r = rawRun("guard.mjs", patch("*** Delete File: test/calc.test.mjs"));
  assert.equal(r.status, 0);
  const o = JSON.parse(r.stdout);
  assert.equal(o.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(o.hookSpecificOutput.permissionDecision, "deny");
  assert.match(o.hookSpecificOutput.permissionDecisionReason, /tamperproof: blocked apply_patch deleting/);
});
test("codex protocol: allowed calls print nothing on stdout", () => {
  const r = rawRun("guard.mjs", patch("*** Update File: src/calc.mjs\n@@\n-a\n+b"));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
test("snapshot: PostToolUse without a matching PreToolUse is a no-op", () => assert.equal(run("guard.mjs", { ...sh("true"), hook_event_name: "PostToolUse", tool_use_id: "never-seen" }).status, 0));
test("TAMPERPROOF_OFF=1 disables the guard", () => assert.equal(run("guard.mjs", patch("*** Delete File: test/calc.test.mjs"), { TAMPERPROOF_OFF: "1" }).status, 0));

// --- Stop gate ---------------------------------------------------------------------------------------
const stop = (sid) => ({ session_id: sid, turn_id: "t9", cwd: repo, hook_event_name: "Stop", model: "gpt", permission_mode: "default", stop_hook_active: false, last_assistant_message: "Done." });
test("codex stop is blocked while tests fail, allowed once they pass", () => {
  writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a, b) => a - b; // touched\n");
  const r = run("verify.mjs", stop("codex-stop-1"));
  assert.equal(r.status, 2);
  assert.equal(r.json.decision, "block", "Codex Stop refusal is {decision: block, reason}");
  assert.match(r.stderr, /npm test --silent` failed/);
  writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a, b) => a + b;\n");
  const r2 = run("verify.mjs", stop("codex-stop-1"));
  assert.equal(r2.status, 0, r2.stderr);
});
test("codex stop gate reports protected files changed during the session (once, without reverting)", () => {
  const sid = "codex-stop-2";
  assert.equal(run("guard.mjs", { ...sh("ls"), session_id: sid }).status, 0); // first shell call records the baseline
  writeFileSync(join(repo, "fixtures", "golden.json"), '{"total": -1}\n'); // changed by a route no hook saw
  const r = run("verify.mjs", stop(sid));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /modified fixtures\/golden\.json/);
  assert.equal(read("fixtures/golden.json"), '{"total": -1}\n', "a stop-time change may be the user's, so it is not reverted");
  assert.equal(run("verify.mjs", stop(sid)).status, 0, "reported once, then the normal test gate decides");
  writeFileSync(join(repo, "fixtures", "golden.json"), '{"total": 5}\n');
});

// --- installer ---------------------------------------------------------------------------------------
test("installer hooks point at the real scripts", () => {
  const h = tamperproofHooks();
  assert.deepStrictEqual(Object.keys(h), ["PreToolUse", "PostToolUse", "Stop"]);
  assert.match(h.PreToolUse[0].matcher, /apply_patch/);
  for (const ev of Object.values(h)) for (const g of ev) for (const x of g.hooks) {
    const script = x.command.match(/"([^"]+)"/)[1];
    assert.ok(existsSync(script), script);
  }
});
test("installer merge keeps other hooks and replaces old tamperproof entries", () => {
  const mine = { matcher: "Bash", hooks: [{ type: "command", command: "node my-lint.mjs" }] };
  const old = { matcher: "Bash", hooks: [{ type: "command", command: 'node "/old/tamperproof/plugins/tamperproof/hooks/guard.mjs"' }] };
  const once = merge({ hooks: { PreToolUse: [mine, old] } }, tamperproofHooks());
  assert.deepStrictEqual(once.hooks.PreToolUse[0], mine);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.deepStrictEqual(merge(once, tamperproofHooks()), once, "idempotent");
  assert.deepStrictEqual(merge(once, {}), { hooks: { PreToolUse: [mine] } }, "uninstall leaves only foreign hooks");
});
test("installer writes, rewrites and removes <repo>/.codex/hooks.json", () => {
  const target = mkdtempSync(join(tmpdir(), "tp-install-"));
  execSync("git init -q", { cwd: target });
  mkdirSync(join(target, ".codex"));
  writeFileSync(join(target, ".codex", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
  const cli = (...a) => spawnSync("node", [INSTALL, ...a], { encoding: "utf8", env });
  assert.equal(cli("--project", target).status, 0);
  assert.equal(cli("--project", target).status, 0);
  const cfg = JSON.parse(readFileSync(join(target, ".codex", "hooks.json"), "utf8"));
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.equal(cfg.hooks.SessionStart.length, 1);
  assert.equal(cli("--project", target, "--uninstall").status, 0);
  assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(join(target, ".codex", "hooks.json"), "utf8")).hooks), ["SessionStart"]);
  assert.ok(JSON.parse(cli("--print").stdout).hooks.Stop);
});
