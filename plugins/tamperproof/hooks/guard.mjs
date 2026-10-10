// PreToolUse: stop the agent from changing existing tests (and the fixtures that hold expected values).
// New test files are fine; editing, deleting or overwriting existing ones is not.
// Exit code 2 blocks the tool call and shows stderr to the agent.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig, isProtected } from "./config.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
if (process.env.TAMPERPROOF_OFF === "1") process.exit(0);
const { protect } = loadConfig(cwd);
const tool = input.tool_name;
const args = input.tool_input || {};

const rel = (p) => { const abs = isAbsolute(p) ? p : resolve(cwd, p); return relative(cwd, abs).replace(/\\/g, "/"); };

function block(what) {
  process.stderr.write(
    `tamperproof: blocked ${what}.\n` +
    `Tests are the spec. Fix the code under test, not the test. If the test itself is genuinely wrong, ` +
    `stop and explain why to the user instead of editing it; they can change it or relax .tamperproof.json.\n`);
  process.exit(2);
}

if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) {
  const target = args.file_path || args.notebook_path;
  if (target) {
    const r = rel(target);
    const isNew = tool === "Write" && !existsSync(resolve(cwd, r));
    if (!isNew && isProtected(r, protect)) block(`${tool} on ${r}`);
  }
  process.exit(0);
}

// Bash uses an allowlist instead of a deny-list of "writer" commands: a deny-list only covers the writers
// someone thought of (sed --in-place, node -e, python -c, ...). Any shell segment that names an existing
// protected path is blocked unless it starts with a known read-only or test-runner command and contains
// no redirect or tee.
const READ_ONLY = new RegExp("^(" + [
  "cat", "less", "more", "head", "tail", "grep", "rg", "ag", "ls", "dir", "wc", "diff", "cmp", "file", "stat", "tree", "bat",
  "git\\s+(diff|log|show|status|blame|ls-files)",
  "npm\\s+(test|t|run\\s+test)", "yarn\\s+test", "pnpm\\s+test", "npx\\s+(jest|vitest|mocha|playwright\\s+test)",
  "node\\s+--test", "jest", "vitest", "mocha", "cargo\\s+(test|nextest)", "go\\s+test", "pytest",
  "python3?\\s+-m\\s+(pytest|unittest)", "swift\\s+test", "dotnet\\s+test", "mvn\\s+test", "gradle\\s+test",
  "\\./gradlew\\s+test", "make\\s+(test|check)", "rspec", "bundle\\s+exec\\s+rspec",
].join("|") + ")(\\s|$)");

if (tool === "Bash") {
  const cmd = String(args.command || "");
  const segments = cmd.split(/&&|\|\||;|\n|\|/).map((x) => x.trim()).filter(Boolean);
  for (const seg of segments) {
    const hits = [];
    // Split on whitespace, quotes and code punctuation so paths inside inline code count too,
    // e.g. node -e "require('fs').writeFileSync('tests/a.test.js', '')".
    for (const piece of seg.split(/[\s'"`,;()=<>{}\[\]]+/)) {
      if (!piece || piece.startsWith("-") || /^[a-z]+:\/\//i.test(piece)) continue;
      const r = rel(piece);
      if (!r.startsWith("..") && isProtected(r, protect) && existsSync(resolve(cwd, r))) hits.push(r);
    }
    if (!hits.length) continue;
    const body = seg.replace(/^(sudo\s+|env\s+(\S+=\S+\s+)+)/, "");
    const writesOut = />/.test(seg) || /(^|\s)tee(\s|$)/.test(seg);
    if (!READ_ONLY.test(body) || writesOut) block(`a shell command touching ${hits[0]}`);
  }
  process.exit(0);
}
process.exit(0);
