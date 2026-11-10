import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "../../scripts/_yaml.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("vendored YAML reads corpus and maintenance policy without installed packages", () => {
  const text = fs.readFileSync(path.join(root, "wiki/kernels/flash-attention-4.md"), "utf8");
  const frontmatter = parse(/^---\s*\n([\s\S]*?)\n---/.exec(text)[1]);
  assert.equal(frontmatter.id, "kernel-flash-attention-4");
  assert.ok(frontmatter.tags.includes("tcgen05"));
  const policy = parse(fs.readFileSync(path.join(root, "data/inclusion-policy.yaml"), "utf8"));
  assert.ok(Array.isArray(policy["cute-dsl"].capture_criteria));
  assert.equal(typeof policy["cute-dsl"].description, "string");
  assert.deepEqual(parse(stringify({ tags: frontmatter.tags })).tags, frontmatter.tags);
});

test("freshness checker stays offline", () => {
  const source = fs.readFileSync(path.join(root, "scripts/check_version_freshness.mjs"), "utf8");
  assert.doesNotMatch(source, /(?:from\s*|import\s*\(\s*)["'](?:node:)?(?:https?|net|tls|dns|child_process)["']/);
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/);
});

test("maintenance checks run outside the clone with only Node on PATH", (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-node-only-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  for (const [script, args] of [
    ["check_dod_fixtures.mjs", []],
    ["verify_core_prs.mjs", []],
    ["check_version_freshness.mjs", ["--today", "2026-08-19"]],
    ["extract_blog_code.mjs", ["--check-all"]],
    ["collect_contest_code.mjs", ["--dry-run"]],
    ["fetch_pr_diff.mjs", ["--all", "--dry-run"]],
    ["compute_core_prs.mjs", ["--stdout"]],
    ["repo_size_check.mjs", []],
  ]) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
      cwd: os.tmpdir(), env: { ...process.env, PATH: bin }, encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${script}: ${result.stdout}\n${result.stderr}`);
  }
});
