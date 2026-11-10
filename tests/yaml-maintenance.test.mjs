import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse, parseMaintenance, stringifyMaintenance } from "../scripts/lib/yaml.mjs";

test("maintenance YAML preserves the original scalar grammar and short Git SHAs", () => {
  const value = parseMaintenance("sha: 0e026982\nscientific: 1e3\nfloat: 1.5e+3\nfloat_without_sign: 1.5e3\noctal: 077\ninvalid_octal: 08\nyes_value: yes\ny: y\nn: N\non_value: on\n");
  assert.deepEqual(value, { sha: "0e026982", scientific: "1e3", float: 1500, float_without_sign: "1.5e3", octal: 63, invalid_octal: "08", yes_value: true, y: "y", n: "N", on_value: true });
  assert.equal(parse("v: yes").v, "yes", "query parsing retains YAML 1.2 behavior");
  const source = { date: "2026-08-18", sha: "0e026982", text: "yes" };
  const emitted = stringifyMaintenance(source);
  assert.deepEqual(parseMaintenance(emitted), source);
  assert.equal(stringifyMaintenance(parseMaintenance(emitted)), emitted);
});

test("maintenance numbers and timestamps retain their types and precision on write", () => {
  for (const source of [
    "score: 0.0000001\n",
    "score: 1.0e+21\n",
    "score: -1.0e+21\n",
    "score: -0.0\n",
    "score: 1.0e+16\n",
    "score: 1.0e+20\n",
    "score: -1.0e+20\n",
    "score: 9.007199254740992e+15\n",
    "v: 2026-08-18T00:00:00Z\n",
    "v: 2026-08-18T12:34:56.123456+02:00\n",
    "v: 2026-08-18\n",
    "receipt_id: 9007199254740993\n",
    "receipt_id: -9007199254740993\n",
  ]) {
    const first = parseMaintenance(source);
    const emitted = stringifyMaintenance(first);
    const second = parseMaintenance(emitted);
    assert.deepEqual(second, first, source);
    assert.equal(stringifyMaintenance(second), emitted, source);
    if (first.v instanceof Date) assert.equal(emitted.trim(), source.trim());
  }
  const score = parseMaintenance(stringifyMaintenance(parseMaintenance("score: 0.0000001\n"))).score;
  assert.equal(typeof score, "number"); assert.equal(score, 1e-7);
  assert.equal(parseMaintenance("receipt_id: 9007199254740993\n").receipt_id, 9007199254740993n);
  assert.equal(parseMaintenance("receipt_id: 9007199254740991\n").receipt_id, Number.MAX_SAFE_INTEGER);
});

test("maintenance timestamp values follow the original grammar and calendar", () => {
  const value = (source) => parseMaintenance(`v: ${source}\n`).v;
  assert.equal(value("2026-08-18T12:34:56+00:01").toISOString(), "2026-08-18T12:33:56.000Z");
  assert.equal(value("0026-08-18").toISOString(), "0026-08-18T00:00:00.000Z");
  assert.equal(value("2026-8-1"), "2026-8-1");
  assert.ok(value("2026-08-18T12:34:56.Z") instanceof Date);
  assert.equal(value("2026-08-18T12:34:56.Z").toISOString(), "2026-08-18T12:34:56.000Z");
  for (const source of ["2026-02-30", "0000-01-01", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+00:60"]) assert.throws(() => value(source), /Invalid YAML timestamp/);
});

test("archived provenance retains its immutable SHA without modifying the asset", () => {
  const source = fs.readFileSync(new URL("../artifacts/prs/cutlass/PR-2466/PROVENANCE.yaml", import.meta.url), "utf8");
  assert.equal(parseMaintenance(source).upstream_sha, "0e026982");
});
