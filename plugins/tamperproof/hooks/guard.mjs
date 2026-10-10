// PreToolUse: stop the agent from changing existing tests. New test files are fine; editing, deleting,
// or overwriting existing ones is not. Exit code 2 blocks the tool call and shows stderr to the agent.
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

if (tool === "Bash") {
  const cmd = String(args.command || "");
  // Only commands that can modify files are interesting; reading or running tests is always allowed.
  const writes = /(^|[\s;&|(])(rm|mv|cp|tee|truncate|unlink|shred|dd)\s|(^|[\s;&|(])(sed|perl)\s+(-[a-zA-Z]*i)|>{1,2}\s*[^\s&|]|git\s+(checkout|restore|rm|mv|stash\s+push)\b|Set-Content|Out-File|Remove-Item|Move-Item/;
  if (!writes.test(cmd)) process.exit(0);
  const tokens = cmd.match(/(?:"[^"]*"|'[^']*'|[^\s;&|<>()]+)/g) || [];
  for (const t of tokens) {
    const p = t.replace(/^['"]|['"]$/g, "");
    if (!p || p.startsWith("-") || /^[a-z]+:\/\//.test(p)) continue;
    const r = rel(p);
    if (r.startsWith("..")) continue;
    if (isProtected(r, protect) && existsSync(resolve(cwd, r))) block(`a shell command touching ${r}`);
  }
  process.exit(0);
}
process.exit(0);
