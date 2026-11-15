// Shared config: which paths count as tests, and which command proves the work.
// Override per project with .tamperproof.json in the repo root:
//   { "protect": ["tests/**", "spec/**"], "verify": "npm test", "maxBlocks": 3,
//     "snapshot": true, "snapshotBudgetMs": 30000 }
// snapshot: false turns off the before/after content check around shell commands (the command allowlist and
// the Stop report still run). snapshotBudgetMs: a snapshot that takes longer than this blocks the command
// with an explanation instead of being killed by the host's hook timeout (60 s in hooks.json).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_PROTECT = [
  "tests/**", "test/**", "__tests__/**", "spec/**", "e2e/**",
  "**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/*_test.py", "**/test_*.py",
  "**/tests/**", "**/__tests__/**", "**/__snapshots__/**", "**/*.snap",
  // where expected values often live outside the test files themselves
  "**/test/resources/**", "fixtures/**", "**/fixtures/**", "testdata/**", "**/testdata/**",
  "golden/**", "**/golden/**", "**/*.golden", "**/expected/**",
  ".tamperproof.json",
];

export function loadConfig(cwd) {
  let user = {};
  const p = join(cwd, ".tamperproof.json");
  if (existsSync(p)) {
    try { user = JSON.parse(readFileSync(p, "utf8")); } catch { /* bad JSON: fall back to defaults */ }
  }
  const protect = [...(user.protect ?? DEFAULT_PROTECT), ".tamperproof.json"];
  return {
    protect, verify: user.verify ?? detectVerify(cwd), maxBlocks: user.maxBlocks ?? 3,
    snapshot: user.snapshot ?? true, snapshotBudgetMs: user.snapshotBudgetMs ?? 30_000,
  };
}

// Guess the project's test command from what's in the repo.
export function detectVerify(cwd) {
  const has = (f) => existsSync(join(cwd, f));
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("go.mod")) return "go test ./...";
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return "npm test --silent";
    } catch { /* ignore */ }
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tests")) return "python -m pytest -q";
  if (has("Package.swift")) return "swift test";
  return null;
}

// Minimal glob: ** = any dirs, * = anything but "/", matched against a repo-relative posix path.
export function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += glob[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function isProtected(relPath, patterns) {
  return compileProtect(patterns)(relPath);
}

// Compile the protect globs once; returns a predicate over repo-relative paths.
export function compileProtect(patterns) {
  const res = patterns.map(globToRegex);
  return (relPath) => {
    const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    return res.some((re) => re.test(p));
  };
}

// Canonical form of an existing path (expands Windows 8.3 short names so relative() lines up).
export function canonical(p) {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

// The project root that .tamperproof.json and the protect globs are relative to.
// Claude Code sets CLAUDE_PROJECT_DIR. Codex does not; it runs hooks in the session cwd and passes
// that cwd in the payload, so fall back to the git toplevel of that cwd, then to the cwd itself.
export function findRoot(cwd) {
  if (process.env.CLAUDE_PROJECT_DIR) return canonical(process.env.CLAUDE_PROJECT_DIR);
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status === 0 && r.stdout.trim()) return canonical(r.stdout.trim());
  return canonical(cwd);
}

// Where per-session state, snapshots and file backups live. Override with TAMPERPROOF_STATE_DIR.
export function stateDir() {
  return process.env.TAMPERPROOF_STATE_DIR || join(tmpdir(), "tamperproof");
}
