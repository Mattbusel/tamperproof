// PreToolUse / PostToolUse / PostToolUseFailure guard for Claude Code and OpenAI Codex CLI: stop the agent from
// changing existing tests (and the fixtures that hold expected values). New test files are fine; editing,
// deleting, renaming or overwriting existing ones is not. A refusal blocks the call (or, after the fact, replaces
// the tool result) and shows the reason to the agent; see emit.mjs for how each host is told.
//
//   Claude Code: Edit / MultiEdit / Write / NotebookEdit / Bash
//   Codex:       apply_patch (every file in the patch is checked) / Bash (exec_command, shell)
//
// Shell commands get two layers: an allowlist check on the command text before it runs, and a content
// snapshot of every protected file taken before and compared after, so a script that rewrites tests
// without naming them (`node fix.mjs`) is caught, reverted and reported. Claude Code runs PostToolUse only
// when a command succeeds and PostToolUseFailure when it exits non-zero; both get the same check, so
// `node fix.mjs; false` is reverted too. Codex runs PostToolUse either way.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonical, compileProtect, findRoot, loadConfig, stateDir } from "./config.mjs";
import { checkFileTool, checkPatch, checkShell, formatterOnly, shellText } from "./rules.mjs";
import { classify, describe, diffSnapshot, restore, takeSnapshot } from "./snapshot.mjs";
import { note, refuse } from "./emit.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (process.env.TAMPERPROOF_OFF === "1") process.exit(0);
const cwd = canonical(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const root = findRoot(cwd);
const config = loadConfig(root);
const isProtected = compileProtect(config.protect);
const ctx = { root, cwd, isProtected, exists: (rel) => existsSync(resolve(root, rel)) };
const tool = input.tool_name;
const args = input.tool_input || {};
const event = input.hook_event_name || "PreToolUse";
const POST_EVENTS = ["PostToolUse", "PostToolUseFailure"];

const FILE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
const PATCH_TOOLS = ["apply_patch"];
const SHELL_TOOLS = ["Bash", "exec_command", "shell", "shell_command", "local_shell", "unified_exec", "container.exec"];

function block(what) {
  refuse(input, "PreToolUse",
    `tamperproof: blocked ${what}.\n` +
    `Tests are the spec. Fix the code under test, not the test. If the test itself is genuinely wrong, ` +
    `stop and explain why to the user instead of editing it; they can change it or relax .tamperproof.json.\n`);
}

// Per-project state: content backups, per-call snapshots and the session baseline used by verify.mjs.
const proj = join(stateDir(), createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16));
const blobDir = join(proj, "blobs");
const clean = (s) => String(s || "default").replace(/[^\w-]/g, "");
const preFile = join(proj, "pre", `${clean(input.session_id)}-${clean(input.tool_use_id || "last")}.json`);
const baselineFile = join(proj, "sessions", `${clean(input.session_id)}.json`);
const firstLine = (s) => s.split("\n")[0].slice(0, 120);

if (event === "PreToolUse") {
  if (FILE_TOOLS.includes(tool)) {
    const hit = checkFileTool(ctx, tool, args.file_path || args.notebook_path);
    if (hit) block(hit);
  } else if (PATCH_TOOLS.includes(tool)) {
    const hit = checkPatch(ctx, args.command ?? args.patch ?? args.input ?? "");
    if (hit) block(hit);
  } else if (SHELL_TOOLS.includes(tool)) {
    const hit = checkShell(ctx, shellText(args));
    if (hit) block(hit);
    if (!config.snapshot) process.exit(0);
    // Allowed: remember what every protected file looks like so the post-check can tell if the command wrote
    // one. If that can't be done in time, say so and don't run the command: a silently skipped snapshot is a
    // silently disabled check.
    let snap;
    try {
      snap = takeSnapshot(root, isProtected, blobDir, { budgetMs: config.snapshotBudgetMs });
      mkdirSync(join(proj, "pre"), { recursive: true });
      writeFileSync(preFile, JSON.stringify({ root, ...snap, at: Date.now() }));
    } catch (e) {
      refuse(input, "PreToolUse",
        `tamperproof: did not run this command because it could not snapshot the protected test files first ` +
        `(${e.message.split("\n")[0]}). Without the snapshot it can't check whether the command rewrites tests.\n` +
        `Tell the user. They can narrow "protect" or raise "snapshotBudgetMs" in .tamperproof.json, or set ` +
        `"snapshot": false there to rely on the command allowlist and the Stop report only.\n`);
    }
    if (!existsSync(baselineFile)) {
      try {
        mkdirSync(join(proj, "sessions"), { recursive: true });
        writeFileSync(baselineFile, JSON.stringify({ root, files: snap.files, git: snap.git }));
      } catch { /* the per-call check still runs; the Stop report just has no baseline */ }
    }
  }
  process.exit(0);
}

if (POST_EVENTS.includes(event) && SHELL_TOOLS.includes(tool)) {
  if (!existsSync(preFile)) process.exit(0);
  let pre;
  try { pre = JSON.parse(readFileSync(preFile, "utf8")); } catch { process.exit(0); }
  rmSync(preFile, { force: true });
  const cmdText = shellText(args);
  const cmd = firstLine(cmdText);
  let changes, sorted;
  try {
    changes = diffSnapshot(root, pre.files || {}, blobDir);
    if (!changes.length) process.exit(0);
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts || {}; } catch { /* none */ }
    sorted = classify(root, changes, pre.git, { formatterOnly: formatterOnly(cmdText, scripts) });
  } catch (e) {
    note(input, event, `tamperproof: could not check whether \`${cmd}\` changed protected test files (${e.message.split("\n")[0]}). ` +
      `Tell the user; the Stop check will still compare against the start of the session.`);
  }
  const { revert, viaGit, viaFormatter } = sorted;
  const left = [
    viaGit.length ? `Changed through git (checkout, pull, merge, rebase, reset, stash, commit), left as is:\n${describe(viaGit, [], "left as is")}` : "",
    viaFormatter.length ? `Reformatted by a formatter, left as is. Check the diff: formatting must not change what a test checks:\n${describe(viaFormatter, [], "left as is")}` : "",
  ].filter(Boolean).join("\n");
  if (!revert.length) note(input, event, `tamperproof: \`${cmd}\` changed protected test files.\n${left}\nThe Stop check will list them for the user.`);
  const failed = restore(root, revert, blobDir);
  refuse(input, event,
    `tamperproof: \`${cmd}\` changed protected test files, so tamperproof put them back:\n${describe(revert, failed)}\n` +
    (left ? left + "\n" : "") +
    `Tests are the spec. Fix the code under test, not the test, and don't write tests through scripts. ` +
    `If a test is genuinely wrong, stop and explain why to the user; they can change it or relax .tamperproof.json.\n`);
}
process.exit(0);
