#!/usr/bin/env node
// Install tamperproof's hooks for OpenAI Codex CLI.
//
//   node plugins/tamperproof/codex/install.mjs              # this repo: <git root>/.codex/hooks.json
//   node plugins/tamperproof/codex/install.mjs --global     # every repo: $CODEX_HOME/hooks.json (~/.codex)
//   node plugins/tamperproof/codex/install.mjs --project D  # repo at D
//   node plugins/tamperproof/codex/install.mjs --print      # print the hooks JSON, write nothing
//   node plugins/tamperproof/codex/install.mjs --uninstall  # remove tamperproof's entries again
//
// Existing hooks in the file are kept; only earlier tamperproof entries are replaced. Codex skips new or
// changed hooks until you trust them: run `/hooks` in Codex once after installing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks").replace(/\\/g, "/");
const MARK = /tamperproof[\\/]+(plugins[\\/]+tamperproof[\\/]+)?hooks[\\/]+(guard|verify)\.mjs/;

// The hook groups tamperproof needs, in Codex's hooks.json shape (event -> matcher group -> handlers).
// Codex reports shell calls as tool_name "Bash" and patches as "apply_patch".
// Codex has no PostToolUseFailure event: it runs PostToolUse after a shell command that exits non-zero too
// (checked live on codex-cli 0.167.0-alpha.4.1 with `node -e "process.exit(3)"`), so the post-check needs no extra entry.
export function tamperproofHooks(hooksDir = HOOKS_DIR) {
  const node = (script) => `node "${hooksDir}/${script}"`;
  return {
    PreToolUse: [{ matcher: "Bash|apply_patch", hooks: [{ type: "command", command: node("guard.mjs"), timeout: 60 }] }],
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: node("guard.mjs"), timeout: 60 }] }],
    Stop: [{ hooks: [{ type: "command", command: node("verify.mjs"), timeout: 600 }] }],
  };
}

const isOurs = (group) => (group.hooks || []).some((h) => MARK.test(String(h.command || "")));

// Merge into an existing hooks.json object: drop earlier tamperproof groups, keep everything else.
export function merge(existing, add) {
  const out = { ...(existing || {}), hooks: { ...((existing && existing.hooks) || {}) } };
  for (const ev of Object.keys(out.hooks)) {
    out.hooks[ev] = (out.hooks[ev] || []).filter((g) => !isOurs(g));
    if (!out.hooks[ev].length) delete out.hooks[ev];
  }
  for (const [ev, groups] of Object.entries(add || {})) out.hooks[ev] = [...(out.hooks[ev] || []), ...groups];
  return out;
}

function main(argv) {
  const flag = (f) => argv.includes(f);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (flag("--help") || flag("-h")) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  if (flag("--print")) { process.stdout.write(JSON.stringify({ hooks: tamperproofHooks() }, null, 2) + "\n"); return 0; }

  let dir;
  if (flag("--global")) dir = process.env.CODEX_HOME || join(homedir(), ".codex");
  else {
    const start = resolve(opt("--project") || process.cwd());
    const g = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    dir = join(g.status === 0 && g.stdout.trim() ? g.stdout.trim() : start, ".codex");
  }
  const file = join(dir, "hooks.json");
  let existing = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf8")); }
    catch { process.stderr.write(`tamperproof: ${file} is not valid JSON; fix or remove it first.\n`); return 1; }
  }
  const next = merge(existing, flag("--uninstall") ? {} : tamperproofHooks());
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  process.stdout.write(flag("--uninstall")
    ? `tamperproof: removed its hooks from ${file}\n`
    : `tamperproof: wrote Codex hooks to ${file}\nNext: open Codex in the repo and run /hooks to review and trust them (Codex skips untrusted hooks).\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
