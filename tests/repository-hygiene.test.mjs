import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkRepositoryHygiene } from "../scripts/check-hygiene.mjs";
import { put, snapshot, tempRoot } from "./helpers/maintenance-fixtures.mjs";

function fixture(t) {
  const root = tempRoot(t);
  for (const directory of ["data/evidence", "candidates", "tests/fixtures"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  put(root, "data/tags.json", '{"tags":[]}\n');
  put(root, "candidates/demo.json", '{"prs":[]}\n');
  put(root, "tests/fixtures/pr-policy-cases.json", '{"cases":[]}\n');
  return root;
}

const script = fileURLToPath(new URL("../scripts/check-hygiene.mjs", import.meta.url));

test("published repository follows the machine-data ownership contract", () => {
  assert.deepEqual(checkRepositoryHygiene(), []);
});

test("repository hygiene checks published data while ignoring local process archives", (t) => {
  const root = fixture(t);
  put(root, ".dev/audit/phase3-review.md", "historical review\n");
  put(root, ".dev/task/plan.md", "current work\n");
  put(root, "SANITIZED.yaml", "files: []\n");
  put(root, "artifacts/example/PROVENANCE.yaml", "origin_url: https://example.org\n");
  assert.deepEqual(checkRepositoryHygiene(root), []);
});

test("repository hygiene rejects mixed data formats and migration or phase filenames", (t) => {
  const root = fixture(t);
  for (const name of [
    "data/config.yaml",
    "data/review.md",
    "data/phase3-budget.json",
    "tests/fixtures/python-policy.json",
  ]) {
    put(root, name, "{}\n");
  }
  const errors = checkRepositoryHygiene(root).join("\n");
  for (const name of ["config.yaml", "review.md", "phase3-budget.json", "python-policy.json"]) {
    assert.ok(errors.includes(name), name);
  }
});

test("repository hygiene validates JSON content and rejects published development trees", (t) => {
  const root = fixture(t);
  put(root, "data/broken.json", '{"bad":\n');
  put(root, "audit/review.json", "{}\n");
  put(root, "plan-phase2.md", "obsolete plan\n");
  const errors = checkRepositoryHygiene(root).join("\n");
  assert.match(errors, /data\/broken\.json: invalid JSON/);
  assert.match(errors, /audit/);
  assert.match(errors, /plan-phase2\.md/);
});

test("nested audit reports and unowned JSON cannot enter product data", (t) => {
  const root = fixture(t);
  put(root, "data/audit/coverage.json", "{}\n");
  put(root, "data/unowned.json", "{}\n");
  put(root, "candidates/review.json", "{}\n");
  const errors = checkRepositoryHygiene(root).join("\n");
  assert.match(errors, /data\/audit/);
  assert.match(errors, /data\/unowned\.json: no declared product-data owner/);
  assert.match(errors, /candidates\/review\.json: use a domain name/);
});

test("machine-data paths reject symlink ancestors into local archives", (t) => {
  const root = fixture(t);
  const archive = path.join(root, ".dev/archive/tests");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.renameSync(path.join(root, "tests"), archive);
  fs.symlinkSync(archive, path.join(root, "tests"), "dir");
  assert.match(
    checkRepositoryHygiene(root).join("\n"),
    /tests: expected a regular machine-data directory/,
  );
});

test("repository hygiene CLI is read-only and fails on new stale records", (t) => {
  const root = fixture(t);
  const run = (args = []) =>
    spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
  const before = snapshot(root);
  assert.equal(run().status, 0);
  assert.deepEqual(snapshot(root), before);
  put(root, "tests/fixtures/legacy.yaml", "value: 1\n");
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /legacy\.yaml/);
  assert.equal(run(["--unknown"]).status, 2);
});
