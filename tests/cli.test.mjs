import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(script, args, options = {}) {
  return execFileSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
}
test("query filters by tag and type", () => {
  const output = run("query.mjs", ["--tag", "nvfp4", "--type", "kernel", "--compact"]);
  assert.match(output, /# 4 result\(s\)/);
  assert.match(output, /kernel-nvfp4-gemm/);
});
test("query matches a documented product alias", () => {
  const output = run("query.mjs", [
    "--architecture",
    "B200",
    "--type",
    "kernel",
    "--compact",
    "--limit",
    "2",
  ]);
  assert.match(output, /# [12] result\(s\)/);
});
test("query runs without a Python interpreter on PATH", () => {
  const output = run("query.mjs", ["--tag", "nvfp4", "--type", "kernel", "--compact"], {
    env: {
      PATH: path.dirname(process.execPath),
    },
  });
  assert.match(output, /kernel-nvfp4-gemm/);
});
test("get_page resolves an id and prints frontmatter", () => {
  const output = run("get_page.mjs", ["kernel-flash-attention-4", "--frontmatter-only"]);
  assert.match(output, /^id: kernel-flash-attention-4$/m);
});
test("get_page exits 1 for an unknown page", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "get_page.mjs"), "no-such-page"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: No page found/);
});
test("grep_wiki searches only wiki files", () => {
  const output = run("grep_wiki.mjs", ["tcgen05", "--only", "wiki", "--files-only"]);
  assert.match(output, /wiki\/kernels\/flash-attention-4\.md/);
  assert.doesNotMatch(output, /^sources\//m);
});
test("grep_wiki rejects an invalid regex", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "grep_wiki.mjs"), "["], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid regex/);
});
test("repo_status counts the generated query indices", () => {
  const output = run("repo_status.mjs", []);
  assert.match(output, /^Corpus counts:$/m);
  assert.match(output, /Query indices: 7/);
});
