import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../../", import.meta.url);
const bytes = (file) => fs.readFileSync(new URL(file, root));
const hash = (file) => createHash("sha256").update(bytes(file)).digest("hex");
const json = (file) => JSON.parse(bytes(file));

test("migrated receipts bind the current policy and its frozen Python parity evidence", () => {
  const fixture = json("tests/fixtures/python-policy-baseline.json");
  for (const file of ["audit/pr-file-cap-reconstruction.json", "data/pr-architecture-evidence.json"]) {
    const receipt = json(file), migration = receipt.policy_migration;
    assert.equal(migration.from_sha256, fixture.source_sha256);
    assert.equal(migration.from_implementation, "scripts/pr_policy.py");
    assert.equal(migration.to_implementation, "scripts/pr_policy.mjs");
    assert.equal(migration.parity_cases, fixture.cases.length);
    assert.equal(migration.parity_fixture_sha256, hash(migration.parity_fixture));
    assert.equal(receipt.policy_sha256, hash(migration.to_implementation));
  }
  assert.equal(json("data/pr-architecture-evidence.json").capped_file_correction_receipt_sha256, hash("audit/pr-file-cap-reconstruction.json"));
});
