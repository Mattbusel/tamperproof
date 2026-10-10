// Stop: before the agent says it's done, run the project's real test command. If it fails, block the stop
// and hand the agent the failing output. Gives up after maxBlocks attempts so a session never loops forever.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
if (process.env.TAMPERPROOF_OFF === "1") process.exit(0);
const { verify, maxBlocks } = loadConfig(cwd);
if (!verify) process.exit(0);

// Only verify when the working tree has changes; a question-and-answer session shouldn't run the suite.
try {
  const dirty = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (!dirty.trim()) process.exit(0);
} catch { /* not a git repo: verify anyway */ }

const stateDir = join(tmpdir(), "tamperproof"); mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, `${(input.session_id || "default").replace(/[^\w-]/g, "")}.json`);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { blocks: 0 };

const run = spawnSync(verify, { cwd, shell: true, encoding: "utf8", timeout: 570_000 });
if (run.status === 0) { writeFileSync(stateFile, JSON.stringify({ blocks: 0 })); process.exit(0); }

if (state.blocks >= maxBlocks) {
  writeFileSync(stateFile, JSON.stringify({ blocks: 0 }));
  process.stderr.write(`tamperproof: \`${verify}\` still fails after ${maxBlocks} tries; letting the session end. Tell the user the tests are failing.\n`);
  process.exit(0);
}
writeFileSync(stateFile, JSON.stringify({ blocks: state.blocks + 1 }));
const out = ((run.stdout || "") + (run.stderr || "")).split("\n").slice(-40).join("\n");
process.stderr.write(
  `tamperproof: not done yet. \`${verify}\` failed (exit ${run.status}). Attempt ${state.blocks + 1} of ${maxBlocks}.\n` +
  `Fix the code until it passes. Do not edit or skip tests.\n--- last 40 lines ---\n${out}\n`);
process.exit(2);
