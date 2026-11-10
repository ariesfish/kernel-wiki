import assert from "node:assert/strict";
import { test } from "node:test";

import { architectureMatchesFilter } from "../scripts/lib/architectures.mjs";

test("exact, family, and unknown sets are disjoint and hierarchical", () => {
  const rows = [
    [["sm100"], "exact"],
    [["sm100a"], "exact"],
    [["sm120"], "exact"],
    [["blackwell"], "family"],
    [["sm90"], "exact"],
    [[], "unknown"],
  ];
  const selected = (requested) =>
    new Set(rows.flatMap((row, index) => (architectureMatchesFilter(...row, requested) ? [index] : [])));

  assert.deepEqual(selected("sm100"), new Set([0]));
  assert.deepEqual(selected("blackwell"), new Set([0, 1, 2, 3]));
  assert.deepEqual(selected("unknown"), new Set([5]));
});

test("a documented product alias is exact, not a family", () => {
  assert.equal(architectureMatchesFilter(["sm100"], "exact", "B200"), true);
  assert.equal(architectureMatchesFilter(["sm100"], "exact", "b200"), true);
  assert.equal(architectureMatchesFilter(["sm100"], "exact", "GB200"), true);
  assert.equal(architectureMatchesFilter(["blackwell"], "family", "B200"), false);
});

test("underscores in a request are ignored", () => {
  assert.equal(architectureMatchesFilter(["sm100"], "exact", "sm_100"), true);
});
