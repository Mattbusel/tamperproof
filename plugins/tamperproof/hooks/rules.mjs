// The checks behind guard.mjs, shared by the Claude Code and Codex hooks. Each check returns a short
// description of what it blocked ("Edit on test/a.test.js"), or null when the call is fine.
//
// ctx = { root, cwd, isProtected(rel), exists(rel) }
//   root: project root the protect globs are relative to
//   cwd:  directory relative paths in the tool call resolve against (the session cwd)
import { isAbsolute, relative, resolve } from "node:path";

// Repo-relative posix path for a path from a tool call, or null when it points outside the root.
export function relPath(ctx, p) {
  const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
  const r = relative(ctx.root, abs).replace(/\\/g, "/");
  if (!r || r.startsWith("../") || r === ".." || isAbsolute(r)) return null;
  return r;
}

// Claude Code file tools (Edit, MultiEdit, Write, NotebookEdit). New files are allowed.
export function checkFileTool(ctx, tool, target) {
  if (!target) return null;
  const r = relPath(ctx, target);
  if (!r || !ctx.isProtected(r)) return null;
  const isNew = tool === "Write" && !ctx.exists(r);
  return isNew ? null : `${tool} on ${r}`;
}

// Parse a Codex apply_patch payload ("*** Begin Patch ... *** End Patch") into file operations:
// [{ op: "add" | "update" | "delete", path, moveTo? }]. Tolerates a heredoc wrapper around it.
export function parsePatch(text) {
  const ops = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/))) {
      cur = { op: m[1].toLowerCase(), path: m[2].trim() };
      ops.push(cur);
    } else if ((m = line.match(/^\*\*\* Move to: (.+)$/)) && cur) {
      cur.moveTo = m[1].trim();
    }
  }
  return ops;
}

// Codex apply_patch: block updates, deletes and renames of existing protected files, and adds that
// would overwrite one. Adding a brand-new test file is allowed, same as Write in Claude Code.
export function checkPatch(ctx, text) {
  for (const o of parsePatch(text)) {
    const src = relPath(ctx, o.path);
    const srcProtected = src && ctx.isProtected(src);
    if (o.op === "delete" && srcProtected) return `apply_patch deleting ${src}`;
    if (o.op === "update" && srcProtected) return o.moveTo ? `apply_patch renaming ${src}` : `apply_patch editing ${src}`;
    if (o.op === "add" && srcProtected && ctx.exists(src)) return `apply_patch overwriting ${src}`;
    if (o.moveTo) {
      const dst = relPath(ctx, o.moveTo);
      if (dst && ctx.isProtected(dst) && ctx.exists(dst)) return `apply_patch moving a file onto ${dst}`;
    }
  }
  return null;
}

// Shell commands use an allowlist instead of a deny-list of "writer" commands: a deny-list only covers
// the writers someone thought of (sed --in-place, node -e, python -c, ...). Any shell segment that names
// an existing protected path is blocked unless it starts with a known read-only or test-runner command and
// contains no redirect or tee. Scripts that write tests without naming them (node fix.mjs) are caught
// after the fact by the snapshot check in guard.mjs.
const READ_ONLY = new RegExp("^(" + [
  "cat", "less", "more", "head", "tail", "grep", "rg", "ag", "ls", "dir", "wc", "diff", "cmp", "file", "stat", "tree", "bat",
  "git\\s+(diff|log|show|status|blame|ls-files)",
  "npm\\s+(test|t|run\\s+test)", "yarn\\s+test", "pnpm\\s+test", "npx\\s+(jest|vitest|mocha|playwright\\s+test)",
  "node\\s+--test", "jest", "vitest", "mocha", "cargo\\s+(test|nextest)", "go\\s+test", "pytest",
  "python3?\\s+-m\\s+(pytest|unittest)", "swift\\s+test", "dotnet\\s+test", "mvn\\s+test", "gradle\\s+test",
  "\\./gradlew\\s+test", "make\\s+(test|check)", "rspec", "bundle\\s+exec\\s+rspec",
].join("|") + ")(\\s|$)");
// Codex on Windows runs commands through PowerShell; these cmdlets only read.
const READ_ONLY_PS = /^(get-content|gc|type|select-string|sls|get-childitem|gci|get-item|gi|test-path|get-filehash|measure-object)(\s|$)/i;

export function checkShell(ctx, cmd) {
  cmd = String(cmd || "");
  // Older Codex builds (and some agents) apply patches through the shell: `apply_patch <<'EOF' ...`.
  if (cmd.includes("*** Begin Patch")) {
    const hit = checkPatch(ctx, cmd);
    if (hit) return hit;
  }
  const segments = cmd.split(/&&|\|\||;|\n|\|/).map((x) => x.trim()).filter(Boolean);
  for (const seg of segments) {
    const hits = [];
    // Split on whitespace, quotes and code punctuation so paths inside inline code count too,
    // e.g. node -e "require('fs').writeFileSync('tests/a.test.js', '')".
    for (const piece of seg.split(/[\s'"`,;()=<>{}\[\]]+/)) {
      if (!piece || piece.startsWith("-") || /^[a-z]+:\/\//i.test(piece)) continue;
      const r = relPath(ctx, piece);
      if (r && ctx.isProtected(r) && ctx.exists(r)) hits.push(r);
    }
    if (!hits.length) continue;
    const body = seg.replace(/^(sudo\s+|env\s+(\S+=\S+\s+)+)/, "").replace(/^&\s*/, "");
    const writesOut = />/.test(seg) || /(^|\s)(tee|tee-object)(\s|$)/i.test(seg);
    const readOnly = READ_ONLY.test(body) || READ_ONLY_PS.test(body);
    if (!readOnly || writesOut) return `a shell command touching ${hits[0]}`;
  }
  return null;
}

// Codex has carried shell commands as a string (`command`, `cmd`) and as an argv array
// (["bash", "-lc", "script"], ["powershell.exe", "-Command", "script"]). Normalise to a script string.
export function shellText(toolInput) {
  const c = toolInput?.command ?? toolInput?.cmd ?? "";
  if (!Array.isArray(c)) return String(c);
  const i = c.findIndex((a) => /^(-l?c|-Command|\/c)$/i.test(String(a)));
  return i >= 0 && i < c.length - 1 ? c.slice(i + 1).join(" ") : c.join(" ");
}

// Formatters rewrite files, tests included, without changing what they check. guard.mjs reports (instead of
// reverting) protected files changed by a command when *every* part of that command is a formatter, or one of
// a few harmless helpers (cd, echo, git diff/status). `prettier --write . && node fix.mjs` is not formatter-only,
// so the script's writes are still reverted. `npm run <script>` (also pnpm/yarn/bun) counts when the
// package.json script it names is itself formatter-only.
const FORMATTER = new RegExp("^(" + [
  /prettier\b.*\s(--write|-w)\b/, /eslint\b.*\s--fix\b/, /biome\s+(format|lint|check)\b.*\s(--write|--apply|--fix)\b/,
  /dprint\s+fmt/, /deno\s+(fmt|lint\s+--fix)/, /standard\b.*\s--fix\b/, /xo\b.*\s--fix\b/,
  /cargo\s+(\+\S+\s+)?(fmt|clippy\b.*\s--fix\b)/, /rustfmt/,
  /black/, /isort/, /ruff\s+format/, /ruff\s+(check\s+)?.*--fix\b/, /autopep8\b.*\s(-i|--in-place)\b/, /yapf\b.*\s(-i|--in-place)\b/,
  /gofmt\b.*\s-w\b/, /goimports\b.*\s-w\b/, /go\s+fmt/, /golangci-lint\s+run\b.*\s--fix\b/,
  /clang-format\b.*\s-i\b/, /dotnet\s+format/, /swiftformat/, /swift-format\b.*\s(-i|--in-place)\b/, /swift\s+format\b/,
  /ktlint\b.*\s(-F|--format)\b/, /rubocop\b.*\s(-a|-A|--autocorrect|--autocorrect-all)\b/, /standardrb\b.*\s--fix\b/,
  /terraform\s+fmt/, /mix\s+format/, /zig\s+fmt/, /shfmt\b.*\s-w\b/, /stylua/, /php-cs-fixer\s+fix/, /taplo\s+fmt/,
].map((r) => r.source).join("|") + ")(\\s|$)");
const RUNNER_PREFIX = /^(npx|bunx|pnpm\s+(exec|dlx)|yarn\s+(exec|dlx)|uv\s+run|poetry\s+run|pipx\s+run|python3?\s+-m|py\s+-m|bundle\s+exec)\s+/;
const HARMLESS = /^(cd|pushd|popd|echo|true|git\s+(diff|status|log|show))(\s|$)/;

export function formatterOnly(cmd, pkgScripts = {}, depth = 0) {
  const segments = String(cmd || "").split(/&&|\|\||;|\n|\|/).map((x) => x.trim()).filter(Boolean);
  if (!segments.length || />/.test(String(cmd))) return false;
  let sawFormatter = false;
  for (const seg of segments) {
    const body = seg.replace(/^(sudo\s+|env\s+(\S+=\S+\s+)+)/, "").replace(RUNNER_PREFIX, "");
    if (HARMLESS.test(body)) continue;
    if (FORMATTER.test(body)) { sawFormatter = true; continue; }
    const run = body.match(/^(npm\s+run(-script)?|pnpm(\s+run)?|yarn(\s+run)?|bun\s+run)\s+([\w:.-]+)\s*$/);
    if (run && depth < 2 && typeof pkgScripts[run[5]] === "string" && formatterOnly(pkgScripts[run[5]], pkgScripts, depth + 1)) { sawFormatter = true; continue; }
    return false;
  }
  return sawFormatter;
}
