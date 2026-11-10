import assert from "node:assert/strict";
import { test } from "node:test";

import { expandKeyword, loadAliasExpansions } from "../scripts/lib/aliases.mjs";

test("alias expansion resolves a variant to its canonical term", () => {
  assert.deepEqual(expandKeyword("UMMA"), ["UMMA", "tcgen05"]);
  assert.deepEqual(expandKeyword("B200"), ["B200", "sm100"]);
  assert.deepEqual(expandKeyword("NVFP4"), ["NVFP4"]);
});

test("a canonical term expands to itself only", () => {
  assert.deepEqual(expandKeyword("tcgen05"), ["tcgen05"]);
  assert.deepEqual(expandKeyword("blackwell"), ["blackwell"]);
});

test("the alias map keeps the first variant mapping", () => {
  const aliases = loadAliasExpansions();
  assert.equal(aliases.get("b200"), "sm100");
  assert.equal(aliases.get("gb200"), "sm100");
  assert.equal(aliases.get("b300"), "sm103");
  assert.equal(aliases.get("gb300"), "sm103");
});
