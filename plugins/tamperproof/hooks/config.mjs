// Shared config: which paths count as tests, and which command proves the work.
// Override per project with .tamperproof.json in the repo root:
//   { "protect": ["tests/**", "spec/**"], "verify": "npm test", "maxBlocks": 3 }
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PROTECT = [
  "tests/**", "test/**", "__tests__/**", "spec/**", "e2e/**",
  "**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/*_test.py", "**/test_*.py",
  "**/tests/**", "**/__tests__/**", "**/__snapshots__/**", "**/*.snap",
  ".tamperproof.json",
];

export function loadConfig(cwd) {
  let user = {};
  const p = join(cwd, ".tamperproof.json");
  if (existsSync(p)) {
    try { user = JSON.parse(readFileSync(p, "utf8")); } catch { /* bad JSON: fall back to defaults */ }
  }
  const protect = [...(user.protect ?? DEFAULT_PROTECT), ".tamperproof.json"];
  return { protect, verify: user.verify ?? detectVerify(cwd), maxBlocks: user.maxBlocks ?? 3 };
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
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((g) => globToRegex(g).test(p));
}
