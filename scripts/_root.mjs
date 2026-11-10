/**
 * Resolve the wiki root once for every query command.
 *
 * The skill is a flat repository: SKILL.md, data/, wiki/, sources/, and
 * queries/ share one root, so the default is the parent of scripts/.
 * BLACKWELL_WIKI_ROOT overrides it for advanced setups. A root that does not
 * contain data/tags.yaml and wiki/ is a configuration error, not a fallback.
 */

import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function looksLikeWikiRoot(candidate) {
  return isFile(path.join(candidate, "data", "tags.yaml")) && isDir(path.join(candidate, "wiki"));
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveWikiRoot(env = process.env, cwd = process.cwd()) {
  const configured = env.BLACKWELL_WIKI_ROOT;
  if (configured) {
    const candidate = path.resolve(expandHome(configured));
    if (looksLikeWikiRoot(candidate)) return candidate;
    fail(
      `BLACKWELL_WIKI_ROOT='${configured}' does not point at a valid ` +
        "Blackwell kernel wiki (missing data/tags.yaml or wiki/).",
    );
  }

  const defaultRoot = path.resolve(HERE, "..");
  if (looksLikeWikiRoot(defaultRoot)) return defaultRoot;

  const seen = new Set();
  for (const start of [HERE, path.resolve(cwd)]) {
    let candidate = start;
    while (true) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        if (looksLikeWikiRoot(candidate)) return candidate;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }

  fail(
    "Could not locate the Blackwell kernel wiki root.\n" +
      "       Expected a directory containing `data/tags.yaml` and `wiki/`.\n" +
      "       Fix: run scripts from inside the cloned skill directory, or\n" +
      "       set BLACKWELL_WIKI_ROOT to its absolute path.",
  );
  return "";
}

export const WIKI_ROOT = resolveWikiRoot();

export function wikiPath(...parts) {
  return path.join(WIKI_ROOT, ...parts);
}
