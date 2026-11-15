// Content snapshots of protected files, so writes that never name a test in the command line
// (`node fix.mjs`, a Makefile target, a codegen step) are still caught.
//
// guard.mjs takes a snapshot before every shell command and compares after it. Any existing protected file
// that changed or vanished is restored and the agent is told, unless git or a formatter explains the change
// (see classify). verify.mjs compares against the first snapshot of the session before it lets the agent finish.
//
// Cost. A snapshot must fit well inside the host's hook timeout on big repos (thousands of test files,
// hundreds of MB of testdata), so it avoids reading files wherever it can:
//   - In a git repo, a tracked file that `git diff-files` reports clean has the index blob as its content id,
//     and git's object store already holds a copy, so it is neither read nor backed up.
//   - Every file's stat signature (size, mtime, ctime, inode) is cached per project. A file whose signature has
//     not changed is not read again. ctime is part of the signature because a script can reset mtime
//     (utimes) but not ctime.
//   - Only untracked or locally modified protected files are hashed (`git hash-object`, so autocrlf and other
//     clean filters line up with the index) and copied to the backup store.
// Outside git the same stat cache applies, and content ids are SHA-256 of the raw bytes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Files larger than this are hashed but not copied to the backup store. A tracked, clean one can still be
// restored from git; any other change to one is reported, not reverted.
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_WALK = 50_000;
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", "__pycache__", ".pytest_cache", ".venv", "venv", ".tox", ".mypy_cache", ".next", "coverage", ".nyc_output"]);

const git = (root, args, opts = {}) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"], ...opts });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sizeOf = (sig) => (sig ? Number(String(sig).split(":")[0]) : undefined);
const sigOf = (st) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;

// Thrown when a snapshot runs past its time budget; guard.mjs turns it into a refusal instead of letting the
// host kill the hook (which would silently skip the check).
export class SnapshotBudgetError extends Error {}

// Git view of the repo: the index (path -> blob id), untracked files, tracked files whose stat differs from the
// index, and the refs that tell a git operation apart from a script. null outside a git work tree.
export function gitState(root) {
  const dir = git(root, ["rev-parse", "--absolute-git-dir"]);
  if (dir.status !== 0) return null;
  const gitDir = dir.stdout.trim();
  const ref = (name) => { const r = git(root, ["rev-parse", "-q", "--verify", name]); return r.status === 0 ? r.stdout.trim() : null; };
  const inProgress = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].filter((f) => existsSync(join(gitDir, f))).join(",");
  return { gitDir, head: ref("HEAD"), stash: ref("refs/stash"), inProgress };
}

function gitFiles(root) {
  const staged = git(root, ["ls-files", "-z", "-s"]);
  const others = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const dirty = git(root, ["diff-files", "-z", "--name-only"]);
  if (staged.status !== 0 || others.status !== 0 || dirty.status !== 0) return null;
  const index = new Map();
  for (const rec of staged.stdout.split("\0")) {
    const m = rec.match(/^(\d+) ([0-9a-f]+) (\d)\t(.+)$/s);
    if (!m) continue;
    if (m[3] !== "0" || m[1] === "160000") { index.set(m[4], null); continue; } // conflicted or submodule: hash it
    index.set(m[4], m[2]);
  }
  return { index, others: others.stdout.split("\0").filter(Boolean), dirty: new Set(dirty.stdout.split("\0").filter(Boolean)) };
}

// Candidate files under root, repo-relative posix paths, outside git: a bounded directory walk.
export function listFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_WALK) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), prefix + e.name + "/"); }
      else if (e.isFile()) out.push(prefix + e.name);
    }
  };
  walk(root, "");
  return out;
}

// Content ids for `rels` (files that must be read). In git: `git hash-object --stdin-paths`, which applies the
// same clean filters as `git add`, so ids compare with index entries. Outside git: SHA-256 of the bytes.
function hashFiles(root, rels, inGit) {
  const out = new Map();
  if (!rels.length) return out;
  const safe = rels.filter((r) => !/[\r\n]/.test(r));
  if (inGit && safe.length) {
    const r = git(root, ["hash-object", "--stdin-paths"], { input: safe.join("\n") + "\n" });
    const ids = r.status === 0 ? r.stdout.trim().split(/\r?\n/) : [];
    if (ids.length === safe.length) { safe.forEach((rel, i) => out.set(rel, ids[i])); return out; }
  }
  for (const rel of rels) { try { out.set(rel, (inGit ? "raw-" : "") + sha256(readFileSync(join(root, rel)))); } catch { /* vanished */ } }
  return out;
}

const cachePath = (blobDir) => join(dirname(blobDir), "statcache.json");
function loadCache(blobDir) { try { return JSON.parse(readFileSync(cachePath(blobDir), "utf8")); } catch { return {}; } }
function saveCache(blobDir, cache) {
  const p = cachePath(blobDir), tmp = `${p}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(cache)); renameSync(tmp, p); } catch { rmSync(tmp, { force: true }); }
}

function backup(root, rel, h, blobDir, size) {
  const blob = join(blobDir, h);
  if (size > MAX_BACKUP_BYTES || existsSync(blob)) return;
  const tmp = blob + "." + process.pid + ".tmp";
  try { copyFileSync(join(root, rel), tmp); renameSync(tmp, blob); } catch { rmSync(tmp, { force: true }); }
}

// { files: { "<rel>": { h, sig } }, git, stats } for every existing protected file. Content that only lives in
// the working tree (untracked or modified files) is backed up to <blobDir>/<id> so it can be restored later.
// opts.budgetMs: throw SnapshotBudgetError when the snapshot takes longer than this.
export function takeSnapshot(root, isProtected, blobDir, opts = {}) {
  const started = Date.now();
  const over = () => opts.budgetMs && Date.now() - started > opts.budgetMs;
  mkdirSync(blobDir, { recursive: true });
  const gs = gitState(root);
  const gf = gs ? gitFiles(root) : null;
  const inGit = Boolean(gf);
  const rels = inGit ? [...gf.index.keys(), ...gf.others] : listFiles(root);
  const cache = loadCache(blobDir);
  const files = {}, toHash = [], stats = { files: 0, hashed: 0, cached: 0, fromIndex: 0 };
  for (const rel of rels) {
    if (!isProtected(rel)) continue;
    if ((++stats.files & 255) === 0 && over()) throw new SnapshotBudgetError(`snapshot of ${stats.files}+ protected files took over ${opts.budgetMs} ms`);
    let st;
    try { st = statSync(join(root, rel)); } catch { continue; }
    if (!st.isFile()) continue;
    const sig = sigOf(st);
    const c = cache[rel];
    const indexId = inGit ? gf.index.get(rel) : undefined;
    if (c && c.sig === sig) { files[rel] = { h: c.h, sig }; stats.cached++; }
    else if (indexId && !gf.dirty.has(rel)) { files[rel] = { h: indexId, sig }; stats.fromIndex++; }
    else { files[rel] = { h: null, sig, size: st.size }; toHash.push(rel); }
    if (files[rel].h && indexId !== files[rel].h) backup(root, rel, files[rel].h, blobDir, st.size);
  }
  if (over()) throw new SnapshotBudgetError(`snapshot took over ${opts.budgetMs} ms`);
  const ids = hashFiles(root, toHash, inGit);
  stats.hashed = toHash.length;
  for (const rel of toHash) {
    const h = ids.get(rel);
    if (!h) { delete files[rel]; continue; }
    files[rel].h = h;
    if (!inGit || gf.index.get(rel) !== h) backup(root, rel, h, blobDir, files[rel].size);
    delete files[rel].size;
  }
  for (const [rel, f] of Object.entries(files)) cache[rel] = { sig: f.sig, h: f.h };
  saveCache(blobDir, cache);
  return { files, git: gs && { head: gs.head, stash: gs.stash, inProgress: gs.inProgress }, stats };
}

// Files from `before` that were modified or deleted since: [{ rel, kind, h, now }]. New files are not
// reported: adding tests is fine. Files whose stat signature is unchanged are not read.
export function diffSnapshot(root, before, blobDir) {
  const changes = [], toHash = [];
  const sigs = {};
  for (const [rel, { h, sig }] of Object.entries(before)) {
    let st;
    try { st = statSync(join(root, rel)); } catch { changes.push({ rel, kind: "deleted", h, now: null, size: sizeOf(sig) }); continue; }
    if (!st.isFile()) { changes.push({ rel, kind: "deleted", h, now: null, size: sizeOf(sig) }); continue; }
    sigs[rel] = sigOf(st);
    if (sig && sigs[rel] === sig) continue;
    toHash.push(rel);
  }
  if (toHash.length) {
    const inGit = Boolean(gitState(root));
    // Ids in `before` decide the format: git blob ids, "raw-" sha256 fallbacks, or plain sha256 outside git.
    const ids = hashFiles(root, toHash, inGit);
    const cache = blobDir ? loadCache(blobDir) : null;
    for (const rel of toHash) {
      let now = ids.get(rel);
      if (now && before[rel].h.startsWith("raw-") && !now.startsWith("raw-")) now = "raw-" + sha256(readFileSync(join(root, rel)));
      if (!now) { changes.push({ rel, kind: "deleted", h: before[rel].h, now: null, size: sizeOf(before[rel].sig) }); continue; }
      if (now !== before[rel].h) changes.push({ rel, kind: "modified", h: before[rel].h, now, size: sizeOf(before[rel].sig) });
      else if (cache) cache[rel] = { sig: sigs[rel], h: now }; // touched, same content
    }
    if (cache) saveCache(blobDir, cache);
  }
  return changes;
}

// Blob ids of `rels` in commit `rev` (absent paths map to null). One git call per commit; null on error.
function treeBlobs(root, rev, rels) {
  if (!rev || !rels.length) return null;
  const r = git(root, ["ls-tree", "-z", "--full-tree", rev, "--", ...rels]);
  if (r.status !== 0) return null;
  const out = new Map(rels.map((x) => [x, null]));
  for (const rec of r.stdout.split("\0")) {
    const m = rec.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/s);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// Split `changes` into what tamperproof reverts and what it leaves alone (and reports).
//   git:       the command moved HEAD (checkout, pull, merge, rebase, reset <rev>, commit, cherry-pick) and the
//              file now matches the new HEAD; or it now matches the stash entry that existed before
//              (stash pop/apply); or the command pushed a stash and the file is back at HEAD (git stash);
//              or the command started a merge/rebase that stopped on conflicts and the file is unmerged or staged.
//   formatter: every part of the command is a known formatter (cmd.formatterOnly from rules.mjs).
// Anything else, including `node fix.mjs && git commit --allow-empty`, is reverted.
export function classify(root, changes, gitBefore, { formatterOnly = false } = {}) {
  const revert = [], viaGit = [], viaFormatter = [];
  if (!changes.length) return { revert, viaGit, viaFormatter };
  const after = gitBefore ? gitState(root) : null;
  const rels = changes.map((c) => c.rel);
  const headMoved = after && after.head !== gitBefore.head;
  const stashPushed = after && after.stash && after.stash !== gitBefore.stash;
  const conflicted = after && after.inProgress && after.inProgress !== gitBefore.inProgress;
  const newHead = headMoved ? treeBlobs(root, after.head, rels) : null;
  const oldHead = stashPushed ? treeBlobs(root, gitBefore.head, rels) : null;
  const oldStash = after && gitBefore.stash ? treeBlobs(root, gitBefore.stash, rels) : null;
  // A merge/rebase that stopped on conflicts leaves files unmerged in the index or staged as auto-merged.
  const unmerged = new Set(), staged = new Map();
  if (conflicted) {
    const r = git(root, ["ls-files", "-z", "-s", "--", ...rels]);
    for (const rec of (r.status === 0 ? r.stdout : "").split("\0")) {
      const m = rec.match(/^\d+ ([0-9a-f]+) (\d)\t(.+)$/s);
      if (m && m[2] !== "0") unmerged.add(m[3]); else if (m) staged.set(m[3], m[1]);
    }
  }
  for (const c of changes) {
    const matches = (m) => Boolean(m) && m.has(c.rel) && m.get(c.rel) === c.now; // c.now null + absent path => deleted by git
    const merging = conflicted && (unmerged.has(c.rel) || (c.now && staged.get(c.rel) === c.now));
    if (matches(newHead) || matches(oldStash) || matches(oldHead) || merging) viaGit.push(c);
    else if (formatterOnly && c.now) viaFormatter.push(c);
    else revert.push(c);
  }
  return { revert, viaGit, viaFormatter };
}

// Put changed files back. From the backup store when it holds a copy, otherwise from git's object store
// (with smudge filters, as `git checkout` would write it; if that doesn't match the size the file had, e.g. an
// LF file written by a tool in an autocrlf repo, the unfiltered blob is used when that does). Returns the paths
// that could not be restored.
export function restore(root, changes, blobDir) {
  const failed = [];
  const cat = (args) => spawnSync("git", ["cat-file", ...args], { cwd: root, maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  for (const c of changes) {
    const abs = join(root, c.rel);
    try {
      const blob = join(blobDir, c.h);
      mkdirSync(dirname(abs), { recursive: true });
      if (existsSync(blob)) { copyFileSync(blob, abs); continue; }
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c.h)) throw new Error("no backup");
      let r = cat(["--filters", `--path=${c.rel}`, c.h]);
      if (r.status !== 0) throw new Error("not in git");
      if (c.size !== undefined && r.stdout.length !== c.size) {
        const raw = cat(["blob", c.h]);
        if (raw.status === 0 && raw.stdout.length === c.size) r = raw;
      }
      writeFileSync(abs, r.stdout);
    } catch { failed.push(c.rel); }
  }
  return failed;
}

// How the user can put one file back to its snapshot content, for the Stop report.
export function restoreHint(root, rel, h, blobDir) {
  const q = (s) => `"${s}"`;
  if (existsSync(join(blobDir, h))) return `cp ${q(join(blobDir, h).replace(/\\/g, "/"))} ${q(rel)}`;
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(h)) {
    const idx = git(root, ["ls-files", "-s", "--", rel]);
    if (idx.status === 0 && idx.stdout.includes(` ${h} 0\t`)) return `git checkout -- ${q(rel)}`;
    return `git cat-file --filters --path=${q(rel)} ${h} > ${q(rel)}`;
  }
  return null;
}

// One line per change for the agent, e.g. "modified test/a.test.mjs (restored)".
export function describe(changes, failed = [], note = null) {
  return changes.map((c) => `  ${c.kind} ${c.rel}${note ? ` (${note})` : failed.includes(c.rel) ? " (could not restore: no backup, restore it by hand)" : " (restored)"}`).join("\n");
}

// Keep $TMPDIR/tamperproof/<project> bounded. Called from the Stop hook:
//   - this session's leftover per-call snapshots (a post-check that never ran) are dropped;
//   - any per-call snapshot older than a day, and session baselines older than a week, are dropped;
//   - backups that no remaining snapshot or baseline points at are deleted once they are an hour old
//     (the hour covers a concurrent hook that has written a backup but not yet its snapshot file).
export function prune(proj, sessionId, now = Date.now()) {
  const HOUR = 3600_000, DAY = 24 * HOUR;
  const removed = { pre: 0, sessions: 0, blobs: 0 };
  const ls = (d) => { try { return readdirSync(d).map((f) => join(d, f)); } catch { return []; } };
  const age = (p) => { try { return now - statSync(p).mtimeMs; } catch { return 0; } };
  const keep = new Set();
  const collect = (p) => {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      for (const f of Object.values(j.files || {})) keep.add(f.h);
      for (const h of j.keep || []) keep.add(h); // backups named in an earlier Stop report's restore commands
    } catch { /* unreadable */ }
  };
  for (const p of ls(join(proj, "pre"))) {
    const mine = sessionId && p.split(/[\\/]/).pop().startsWith(`${sessionId}-`);
    if (mine || age(p) > DAY) { rmSync(p, { force: true }); removed.pre++; } else collect(p);
  }
  for (const p of ls(join(proj, "sessions"))) {
    if (age(p) > 7 * DAY) { rmSync(p, { force: true }); removed.sessions++; } else collect(p);
  }
  for (const p of ls(join(proj, "blobs"))) {
    const name = p.split(/[\\/]/).pop();
    if (keep.has(name) || age(p) < HOUR) continue;
    rmSync(p, { force: true }); removed.blobs++;
  }
  return removed;
}
