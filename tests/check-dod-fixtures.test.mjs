import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as DOD from "../scripts/check-dod-fixtures.mjs";
import { parse, stringify } from "../scripts/lib/yaml.mjs";
import { importInRoot, put, ROOT, run, tempRoot } from "./helpers/maintenance-fixtures.mjs";
const current = () => parse(fs.readFileSync(path.join(ROOT, "data/asset-contracts.json"), "utf8"));
test("current active and retired DoD contracts are valid", () => {
  const data = current();
  assert.equal(data.contract_version, 3);
  assert.equal(data.fixtures.length, 3);
  assert.equal(data.retired_fixtures.length, 2);
  assert.deepEqual(DOD.checkFixtureContract(data), []);
  for (const entry of data.fixtures) {
    assert.deepEqual(DOD.checkEntry(entry), []);
  }
  for (const entry of data.retired_fixtures) {
    assert.deepEqual(DOD.checkRetiredEntry(entry), []);
  }
  const result = run("check-dod-fixtures.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checked 3 active and 2 retired/);
});
test("retirement cannot silently drop reason or asset history", () => {
  const errors = DOD.checkRetiredEntry({
    question: "missing evidence",
  });
  for (const field of ["reason", "retired_at", "former_required_assets"]) {
    assert.ok(errors.some((e) => e.includes(field)));
  }
  assert.match(DOD.checkRetiredEntry(null)[0], /must be a mapping/);
  const retired = current().retired_fixtures[0];
  assert.ok(
    DOD.checkRetiredEntry({
      ...retired,
      required_assets: ["active.cu"],
    }).some((e) => e.includes("cannot carry active")),
  );
});
test("active fixture cannot be silently deleted", () => {
  const data = current();
  const removed = data.fixtures.pop();
  assert.ok(DOD.checkFixtureContract(data).some((e) => e.includes(removed.id)));
});
test("fixture and roster row cannot be jointly deleted", () => {
  const data = current();
  const removed = data.fixtures.pop();
  delete data.fixture_roster[removed.id];
  assert.ok(
    DOD.checkFixtureContract(data).some((e) => e.includes("pinned contract-v3 identities")),
  );
});
test("contract rejects duplicates, overlap, invalid states, ids, and section shapes", () => {
  const data = current();
  data.contract_version = 2;
  data.fixtures.push(data.fixtures[0], null, {
    id: " ",
  });
  data.retired_fixtures.push(data.fixtures[0]);
  data.fixture_roster["bogus-id"] = "invalid";
  const errors = DOD.checkFixtureContract(data).join("\n");
  for (const message of [
    "contract_version",
    "duplicate id",
    "both active and retired",
    "invalid state",
    "must be a mapping",
    "requires a non-empty id",
  ]) {
    assert.ok(errors.includes(message), message);
  }
  data.fixtures = {};
  assert.ok(DOD.checkFixtureContract(data).some((e) => e.includes("fixtures must be a list")));
  assert.deepEqual(DOD.checkFixtureContract([]), ["fixture contract must be a mapping"]);
  assert.ok(DOD.checkFixtureContract({}).some((e) => e.includes("fixture_roster")));
});
test("each asset glob independently requires files, enough lines, and both provenance modes", async (t) => {
  const root = tempRoot(t);
  put(root, "artifacts/a/long.cu", "producer\nconsumer\npipeline\n");
  put(
    root,
    "artifacts/a/PROVENANCE.yaml",
    stringify({
      asset_mode: "verbatim",
      files: [
        {
          local_path: "long.cu",
          mode: "verbatim",
        },
      ],
    }),
  );
  const short = put(root, "artifacts/b/nested/short.cu", "mbarrier\n");
  put(
    root,
    "artifacts/b/PROVENANCE.yaml",
    stringify({
      asset_mode: "derived",
      files: [
        {
          local_path: "nested/short.cu",
          mode: "derived",
        },
      ],
    }),
  );
  const dod = await importInRoot("check-dod-fixtures.mjs", root);
  const entry = {
    question: "fixture",
    required_assets: ["artifacts/a/*.cu", "artifacts/b/**/*.cu"],
    required_min_lines: 3,
    required_provenance_modes: ["verbatim"],
    required_bundle_asset_mode: ["verbatim"],
    required_content_patterns: ["PRODUCER", "mbarrier"],
  };
  const errors = dod.checkEntry(entry);
  assert.equal(errors.length, 3, errors.join("\n"));
  for (const e of errors) {
    assert.match(e, /artifacts\/b\/\*\*\/\*\.cu/);
  }
  for (const gate of ["required_min_lines", "per-file provenance", "asset_mode"]) {
    assert.ok(errors.some((e) => e.includes(gate)));
  }
  assert.equal(dod.loadModesForFile(short), "derived");
  assert.equal(dod.loadBundleModeForFile(short), "derived");
  assert.equal(dod.findBundleRootFor(short), path.join(root, "artifacts/b"));
  const override = {
    ...entry,
    required_assets: [
      entry.required_assets[0],
      {
        glob: entry.required_assets[1],
        min_lines: 1,
      },
    ],
    required_provenance_modes: ["verbatim", "derived"],
    required_bundle_asset_mode: ["verbatim", "derived"],
  };
  assert.deepEqual(dod.checkEntry(override), []);
  assert.match(
    dod.checkEntry({
      ...override,
      required_assets: [...override.required_assets, "missing/*.cu"],
    })[0],
    /matched no files/,
  );
});
test("content regex errors and malformed provenance cannot silently pass", async (t) => {
  const root = tempRoot(t);
  const file = put(root, "assets/kernel.cu", "producer\nconsumer\n");
  const prov = put(root, "assets/PROVENANCE.yaml", "files: [\n");
  const dod = await importInRoot("check-dod-fixtures.mjs", root);
  assert.equal(dod.loadModesForFile(file), null);
  assert.equal(dod.loadBundleModeForFile(file), null);
  const errors = dod.checkEntry({
    required_assets: ["assets/*.cu"],
    required_min_lines: 2,
    required_content_patterns: ["[", "absent", "(?s)producer.*consumer"],
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /invalid regex/);
  assert.match(errors[1], /not found/);
  fs.unlinkSync(prov);
  assert.equal(dod.loadModesForFile(file), null);
  assert.equal(dod.findBundleRootFor(file), null);
});
test("missing, malformed, or empty fixture input is an invocation error", (t) => {
  const root = tempRoot(t);
  let result = run("check-dod-fixtures.mjs", [], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AC-7 DoD fixture gate requires/);
  put(root, "data/asset-contracts.json", "fixtures: [");
  result = run("check-dod-fixtures.mjs", [], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not parse/);
  put(root, "data/asset-contracts.json", '{\n  "fixtures": []\n}\n');
  result = run("check-dod-fixtures.mjs", [], root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /has no `fixtures:` entries/);
  assert.equal(run("check-dod-fixtures.mjs", ["--unknown"], root).status, 2);
  assert.equal(run("check-dod-fixtures.mjs", ["--help"], root).status, 0);
});
