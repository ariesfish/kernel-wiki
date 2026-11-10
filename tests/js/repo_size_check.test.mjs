import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ROOT, import_in_root, put, run, snapshot, temp_root } from "./checks-helpers.mjs";

const scripts = ["extract_blog_code.mjs", "collect_contest_code.mjs", "check_dod_fixtures.mjs", "check_version_freshness.mjs", "repo_size_check.mjs"];

test("size excludes .dev process/worktrees and all original exclusions while counting reviewable nested files", async (t) => {
  const root = temp_root(t);
  put(root, "README.md", "abc");
  put(root, "artifacts/a.cu", "kernel");
  put(root, "artifacts/__pycache__/bytecode", "bytecode");
  put(root, "nested/.dev/keep", "kept");
  put(root, "nested/node_modules/keep", "nested");
  put(root, "nested/__pycache__/omit", "omit");
  const size = await import_in_root("repo_size_check.mjs", root);
  for (const dir of size.EXCLUDE_TOP) put(root, `${dir}/ignored`, "ignored state");
  const huge = put(root, ".dev/worktrees/independent/huge.bin", "");
  fs.truncateSync(huge, 100 * 1024 * 1024);
  assert.ok(size.EXCLUDE_TOP.has(".dev"));
  assert.deepEqual(size.working_tree_bytes(), [19, 4]);
  // The artifact file-count gate intentionally includes all artifact files.
  assert.equal(size.artifacts_file_count(), 2);
  const readdir = fs.readdirSync;
  fs.readdirSync = (dir, ...args) => {
    assert.ok(!String(dir).startsWith(path.join(root, ".dev")), "excluded .dev must be pruned before recursion");
    return readdir(dir, ...args);
  };
  try { assert.deepEqual(size.working_tree_bytes(), [19, 4]); }
  finally { fs.readdirSync = readdir; }
});

test("working-tree counts file symlinks, skips broken links, and avoids directory symlink recursion", async (t) => {
  const root = temp_root(t);
  const file = put(root, "artifacts/a.cu", "abc");
  fs.symlinkSync(file, path.join(root, "linked.cu"));
  fs.symlinkSync(path.join(root, "absent"), path.join(root, "broken"));
  fs.symlinkSync(root, path.join(root, "loop"), "dir");
  const size = await import_in_root("repo_size_check.mjs", root);
  assert.deepEqual(size.working_tree_bytes(), [6, 2]);
  assert.equal(size.artifacts_file_count(), 1);
});

test("size budget missing or malformed is advisory; valid budget and CLI override enforce ceilings", async (t) => {
  const root = temp_root(t);
  put(root, "a.txt", "reviewable bytes");
  const size = await import_in_root("repo_size_check.mjs", root);
  assert.equal(size.load_budget(), null);
  assert.equal(size.artifacts_file_count(), 0);
  let result = run("repo_size_check.mjs", [], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no budget file present; skip size gate/);
  put(root, "data/phase3-size-budget.yaml", "active_ceiling_mib: [\n");
  assert.deepEqual(size.load_budget(), {});
  assert.equal(run("repo_size_check.mjs", [], root).status, 0);
  put(root, "data/phase3-size-budget.yaml", "active_ceiling_mib: 0\n");
  result = run("repo_size_check.mjs", [], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds ceiling 0 MiB/);
  result = run("repo_size_check.mjs", ["--ceiling-mib", "1"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source: CLI override/);
  assert.equal(run("repo_size_check.mjs", ["--ceiling-mib", "-1"], root).status, 1);
  assert.equal(run("repo_size_check.mjs", ["--ceiling-mib=0"], root).status, 1);
  for (const args of [["--ceiling-mib", "1.5"], ["--ceiling-mib", "bad"], ["--ceiling-mib"], ["--unknown"]]) assert.equal(run("repo_size_check.mjs", args, root).status, 2);
  assert.equal(run("repo_size_check.mjs", ["--help"], root).status, 0);
});

test("artifact file-count budget is enforced independently of a missing byte-size budget", async (t) => {
  const root = temp_root(t);
  const size = await import_in_root("repo_size_check.mjs", root);
  fs.mkdirSync(path.join(root, "artifacts"));
  for (let i = 0; i < size.FILE_COUNT_BUDGET; i++) fs.writeFileSync(path.join(root, "artifacts", `${i}.cu`), "");
  assert.equal(run("repo_size_check.mjs", [], root).status, 0);
  put(root, "artifacts/extra.cu", "");
  const result = run("repo_size_check.mjs", [], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /artifacts\/ has 6001 files \(> 6000 budget\)/);
});

test("all five modules import without running main or writing files and resolve roots independently of cwd", (t) => {
  const root = temp_root(t);
  const before = snapshot(root);
  const program = `for (const name of ${JSON.stringify(scripts)}) { const mod = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/")).href)} + name); if ((mod.REPO_ROOT || mod.REPO) !== process.env.BLACKWELL_WIKI_ROOT) throw new Error('root mismatch'); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: root, encoding: "utf8", env: { ...process.env, BLACKWELL_WIKI_ROOT: root, PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(snapshot(root), before);
  const default_program = `import path from 'node:path'; for (const name of ${JSON.stringify(scripts)}) { const mod = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/")).href)} + name); if (path.resolve(mod.REPO_ROOT || mod.REPO) !== ${JSON.stringify(path.resolve(ROOT))}) throw new Error('default root depends on cwd'); }`;
  const env = { ...process.env, PATH: "" };
  delete env.BLACKWELL_WIKI_ROOT;
  const defaults = spawnSync(process.execPath, ["--input-type=module", "-e", default_program], { cwd: root, encoding: "utf8", env });
  assert.equal(defaults.status, 0, defaults.stderr);
});
