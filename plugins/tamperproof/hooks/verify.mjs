// Stop gate for Claude Code (Stop) and OpenAI Codex CLI (Stop): before the agent says it's done,
//   1. tamper check: compare every protected file with the session baseline (snapshot taken by guard.mjs
//      before the first shell command). Anything modified or deleted since, by any route, blocks the stop
//      once with the list (reported, not reverted: it may be the user's own edit), with a restore command per
//      file for the user, since the agent itself can't write tests.
//   1b. prune hook state: this session's leftover per-call snapshots, expired baselines, unreferenced backups.
//   2. run the project's real test command. If it fails, block the stop and hand the agent the failing
//      output. Gives up after maxBlocks attempts so a session never loops forever.
// A refusal blocks the stop in both tools (Codex turns the reason into a continuation prompt); see emit.mjs.
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, compileProtect, findRoot, loadConfig, stateDir } from "./config.mjs";
import { diffSnapshot, prune, restoreHint, takeSnapshot } from "./snapshot.mjs";
import { refuse } from "./emit.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (process.env.TAMPERPROOF_OFF === "1") process.exit(0);
const root = findRoot(canonical(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
const { protect, verify, maxBlocks } = loadConfig(root);
const sid = (input.session_id || "default").replace(/[^\w-]/g, "");

// 1. Tamper check against the session baseline.
const proj = join(stateDir(), createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16));
const baselineFile = join(proj, "sessions", `${sid}.json`);
if (existsSync(baselineFile)) {
  let saved = null;
  try { saved = JSON.parse(readFileSync(baselineFile, "utf8")); } catch { /* unreadable: skip */ }
  const blobDir = join(proj, "blobs");
  const changes = saved?.files ? diffSnapshot(root, saved.files, blobDir) : [];
  if (changes.length) {
    // Not reverted here: by the end of a session the change may be the user's own edit, and silently undoing
    // human work is worse than a cheat that gets reported. The agent can't restore them either: the guard blocks
    // every command that writes a test, `git checkout -- <file>` included. So the report gives the agent a
    // restore command per file to pass on to the user. Re-baseline so this fires once per change, and keep the
    // old backups referenced (`keep`) so those restore commands keep working until the baseline expires.
    const list = changes.map((c) => {
      const hint = restoreHint(root, c.rel, c.h, blobDir);
      return `  ${c.kind} ${c.rel}\n      ${hint ? `to restore: ${hint}` : "no backup: restore it from version control by hand"}`;
    }).join("\n");
    try {
      const s = takeSnapshot(root, compileProtect(protect), blobDir);
      const keep = [...new Set([...(saved.keep || []), ...changes.map((c) => c.h)])];
      writeFileSync(baselineFile, JSON.stringify({ root, files: s.files, git: s.git, keep }));
    } catch { /* keep old */ }
    try { prune(proj, sid); } catch { /* best effort */ }
    refuse(input, "Stop",
      `tamperproof: not done yet. Protected test files changed during this session by a route the per-command ` +
      `check left alone (a git operation, a formatter, a background process, or an edit by hand):\n${list}\n` +
      `Don't try to put them back yourself: tamperproof blocks commands that write tests, these included. ` +
      `Tell the user which files changed and give them the restore commands above, so they can decide whether to ` +
      `keep each change. If you caused a change, say how, and fix the code under test instead.\n`);
  }
}
try { prune(proj, sid); } catch { /* best effort */ }

// 2. Run the real tests.
if (!verify) process.exit(0);

// Only verify when the working tree has changes; a question-and-answer session shouldn't run the suite.
try {
  const dirty = execSync("git status --porcelain", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (!dirty.trim()) process.exit(0);
} catch { /* not a git repo: verify anyway */ }

const dir = stateDir(); mkdirSync(dir, { recursive: true });
const stateFile = join(dir, `${sid}.json`);
let state = { blocks: 0 };
try { if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* corrupt: reset */ }

const run = spawnSync(verify, { cwd: root, shell: true, encoding: "utf8", timeout: 570_000 });
if (run.status === 0) { writeFileSync(stateFile, JSON.stringify({ blocks: 0 })); process.exit(0); }

if (state.blocks >= maxBlocks) {
  writeFileSync(stateFile, JSON.stringify({ blocks: 0 }));
  process.stderr.write(`tamperproof: \`${verify}\` still fails after ${maxBlocks} tries; letting the session end. Tell the user the tests are failing.\n`);
  process.exit(0);
}
writeFileSync(stateFile, JSON.stringify({ blocks: state.blocks + 1 }));
const out = ((run.stdout || "") + (run.stderr || "")).split("\n").slice(-40).join("\n");
refuse(input, "Stop",
  `tamperproof: not done yet. \`${verify}\` failed (exit ${run.status}). Attempt ${state.blocks + 1} of ${maxBlocks}.\n` +
  `Fix the code until it passes. Do not edit or skip tests.\n--- last 40 lines ---\n${out}\n`);
