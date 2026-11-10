/**
 * Alias expansion for search keywords and tags.
 *
 * data/aliases.yaml maps a canonical term to its variants. Both directions
 * resolve to the canonical term so `--tag UMMA` finds pages tagged tcgen05,
 * and `--architecture B200` can be normalized by the architecture matcher.
 */

import { readFileSync } from "node:fs";

import { WIKI_ROOT } from "./root.mjs";
import { parse } from "./yaml.mjs";

let cache;

export function loadAliasExpansions() {
  if (cache) return cache;
  const out = new Map();
  try {
    const raw = parse(readFileSync(`${WIKI_ROOT}/data/aliases.yaml`, "utf8")) ?? {};
    for (const [canonical, variants] of Object.entries(raw)) {
      out.set(canonical.toLowerCase(), canonical);
      for (const variant of variants ?? []) {
        if (typeof variant === "string" && !out.has(variant.toLowerCase())) {
          out.set(variant.toLowerCase(), canonical);
        }
      }
    }
  } catch {
    // A missing alias file degrades to exact-term search, not a failed query.
  }
  cache = out;
  return out;
}

export function expandKeyword(keyword) {
  const canonical = loadAliasExpansions().get(keyword.toLowerCase());
  if (canonical && canonical.toLowerCase() !== keyword.toLowerCase()) {
    return [keyword, canonical];
  }
  return [keyword];
}
