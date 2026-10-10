// Runs the real hook scripts against a throwaway repo. `node --test`
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS = join(import.meta.dirname, "..", "plugins", "tamperproof", "hooks");
const repo = mkdtempSync(join(tmpdir(), "tp-"));
mkdirSync(join(repo, "src")); mkdirSync(join(repo, "test"));
writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a, b) => a - b;\n");
writeFileSync(join(repo, "test", "calc.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert"; import { add } from "../src/calc.mjs"; test("add", () => assert.equal(add(2, 3), 5));\n');
mkdirSync(join(repo, "fixtures")); writeFileSync(join(repo, "fixtures", "golden.json"), '{"total": 5}\n');
mkdirSync(join(repo, "src", "test", "resources"), { recursive: true }); writeFileSync(join(repo, "src", "test", "resources", "expected.json"), "5\n");
writeFileSync(join(repo, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n');
execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });

const hook = (name, input) => spawnSync("node", [join(HOOKS, name)], { input: JSON.stringify(input), encoding: "utf8", env: (({ NODE_TEST_CONTEXT, ...rest }) => ({ ...rest, CLAUDE_PROJECT_DIR: repo }))(process.env) });
const edit = (p) => ({ tool_name: "Edit", tool_input: { file_path: join(repo, p) } });
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("blocks editing an existing test", () => assert.equal(hook("guard.mjs", edit("test/calc.test.mjs")).status, 2));
test("allows editing source", () => assert.equal(hook("guard.mjs", edit("src/calc.mjs")).status, 0));
test("allows writing a brand-new test file", () => assert.equal(hook("guard.mjs", { tool_name: "Write", tool_input: { file_path: join(repo, "test/new.test.mjs") } }).status, 0));
test("blocks sed -i on a test", () => assert.equal(hook("guard.mjs", bash("sed -i s/5/-1/ test/calc.test.mjs")).status, 2));
test("blocks deleting a test", () => assert.equal(hook("guard.mjs", bash("rm test/calc.test.mjs")).status, 2));
test("allows running the tests", () => assert.equal(hook("guard.mjs", bash("node --test test/")).status, 0));
// Bypasses reported by a reader (pm25coder on dev.to), plus the general shape: writers we never listed.
const blocked = [
  "sed --in-place -e s/5/-1/ test/calc.test.mjs",
  "sed -i.bak s/5/-1/ test/calc.test.mjs",
  "perl -pi -e s/5/-1/ test/calc.test.mjs",
  `node -e "require('fs').writeFileSync('test/calc.test.mjs', '')"`,
  `python -c "open('test/calc.test.mjs','w').write('')"`,
  "echo '' > test/calc.test.mjs",
  "cat src/calc.mjs > test/calc.test.mjs",
  "echo x | tee test/calc.test.mjs",
  "truncate -s 0 test/calc.test.mjs",
  "git checkout HEAD~1 -- test/calc.test.mjs",
  "awk -i inplace '{print}' test/calc.test.mjs",
  "sed -i s/5/-1/ fixtures/golden.json",
  "rm src/test/resources/expected.json",
];
for (const c of blocked) test(`blocks: ${c}`, () => assert.equal(hook("guard.mjs", bash(c)).status, 2));
const allowed = ["cat test/calc.test.mjs", "grep add test/calc.test.mjs", "npm test", "node --test test/calc.test.mjs", "git diff test/calc.test.mjs", "echo hi > notes.txt", "sed -i s/a/b/ src/calc.mjs"];
for (const c of allowed) test(`allows: ${c}`, () => assert.equal(hook("guard.mjs", bash(c)).status, 0));
test("blocks editing a fixture that holds expected values", () => assert.equal(hook("guard.mjs", edit("fixtures/golden.json")).status, 2));

test("stop is blocked while tests fail, allowed once they pass", () => {
  writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a, b) => a - b; // touched\n");
  assert.equal(hook("verify.mjs", { session_id: "t1" }).status, 2);
  writeFileSync(join(repo, "src", "calc.mjs"), "export const add = (a, b) => a + b;\n");
  assert.equal(hook("verify.mjs", { session_id: "t1" }).status, 0);
});
