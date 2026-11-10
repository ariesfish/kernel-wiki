import assert from "node:assert/strict";
import { test } from "node:test";
import * as indices from "../scripts/generate-indices.mjs";
import { architectureMatchesFilter } from "../scripts/lib/architectures.mjs";
const page = (id, architectures, disposition) => ({
  id,
  title: id,
  _path: id,
  architectures,
  ...(disposition === undefined
    ? {}
    : {
        architecture_disposition: disposition,
      }),
});
const pages = [
  page("exact-sm100", ["sm100"], "exact"),
  page("exact-sm100a", ["sm100a"], "exact"),
  page("exact-sm120", ["sm120"], "exact"),
  page("family", ["blackwell"], "family"),
  page("hand-authored-family", ["blackwell"]),
  page("mixed", ["sm100", "hopper"], "mixed"),
  page("hopper", ["sm90"], "exact"),
  page("unknown", [], "unknown"),
  page("non-pr-empty", []),
];
const paths = (rows) => new Set(rows.map((row) => row._path));
test("index membership equals declared metadata sets", () => {
  const [exact, family, unknown] = indices.architectureIndexSets(pages);
  assert.deepEqual(paths(exact.sm100), new Set(["exact-sm100", "mixed"]));
  assert.deepEqual(paths(family.blackwell), new Set(["family", "hand-authored-family"]));
  assert.deepEqual(paths(unknown), new Set(["unknown"]));
  assert.ok(paths(family.hopper).has("mixed"));
  const rendered = indices.generateByArchitecture(pages);
  for (const phrase of [
    "## Blackwell family-only",
    "no supported exact SM in that family",
    "## Architecture unknown",
    "validated source-PR unknowns",
    "Source-PR pages whose validated evidence review",
    "### `sm100`",
  ]) {
    assert.ok(rendered.includes(phrase), phrase);
  }
});
test("exact index memberships agree with query architecture filtering", () => {
  const [exact, , unknown] = indices.architectureIndexSets(pages);
  for (const [architecture, members] of Object.entries(exact)) {
    assert.deepEqual(
      paths(members),
      paths(
        pages.filter((p) =>
          architectureMatchesFilter(p.architectures, p.architecture_disposition, architecture),
        ),
      ),
    );
  }
  assert.deepEqual(
    paths(unknown),
    paths(
      pages.filter((p) =>
        architectureMatchesFilter(p.architectures, p.architecture_disposition, "unknown"),
      ),
    ),
  );
});
