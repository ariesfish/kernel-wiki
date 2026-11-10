/**
 * Architecture hierarchy and product mappings for query filters.
 *
 * The tables live in data/architectures.json and are shared with corpus
 * maintenance tooling (scripts/pr_policy.mjs). This module only implements the
 * matching semantics; the data stays language-neutral.
 */

import { readFileSync } from "node:fs";

import { WIKI_ROOT } from "./_root.mjs";

const DATA = JSON.parse(readFileSync(`${WIKI_ROOT}/data/architectures.json`, "utf8"));

export const FAMILY_PREFIXES = DATA.families;
export const EXACT_ARCHITECTURES = DATA.exact;
export const PRODUCT_ARCHITECTURES = DATA.products;

/**
 * Canonical user-facing architecture hierarchy semantics.
 *
 * A family request matches the family name or any exact target under it; a
 * documented product name is exact, never the family; `unknown` matches only
 * pages whose disposition is unknown and whose architecture list is empty.
 */
export function architectureMatchesFilter(architectures, disposition, requested) {
  const archs = new Set((architectures ?? []).map((value) => String(value).toLowerCase()));
  let normalized = String(requested).toLowerCase().replaceAll("_", "");

  if (Object.hasOwn(PRODUCT_ARCHITECTURES, normalized)) {
    normalized = PRODUCT_ARCHITECTURES[normalized].architecture;
  }

  if (normalized === "unknown") {
    return disposition === "unknown" && archs.size === 0;
  }

  if (Object.hasOwn(FAMILY_PREFIXES, normalized)) {
    return (
      archs.has(normalized) ||
      [...archs].some((value) => FAMILY_PREFIXES[normalized].some((prefix) => value.startsWith(prefix)))
    );
  }

  return archs.has(normalized);
}
