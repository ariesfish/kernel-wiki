import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as policy from "../scripts/lib/pr-policy.mjs";
const baseline = JSON.parse(
  fs.readFileSync(new URL("./fixtures/pr-policy-cases.json", import.meta.url), "utf8"),
);
const groups = Map.groupBy(baseline.cases, (row) => row.function);
for (const [name, cases] of groups) {
  test(`${name} preserves ${cases.length} frozen policy cases`, () => {
    const fn = policy[name];
    assert.equal(typeof fn, "function", `${name} must resolve to a current policy function`);
    for (const [index, row] of cases.entries()) {
      const result = fn(...structuredClone(row.args));
      // ScopeDecision instances use object properties; tuples become arrays.
      const actual = JSON.parse(JSON.stringify(result));
      assert.deepEqual(
        actual,
        row.expected,
        `${name} frozen case ${index}: ${JSON.stringify(row.args)}`,
      );
    }
  });
}
