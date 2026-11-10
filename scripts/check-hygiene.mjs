#!/usr/bin/env node
/** Enforce product-data ownership without reading local development records. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readJson } from "./lib/json.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MACHINE_DIRECTORIES = ["data", "candidates", "tests/fixtures"];
const PROCESS_NAME =
  /^(?:python-|phase[-_]?\d|plan-phase|plan-supersession|(?:audit|coverage|reviews?|reports?|history|archive|snapshots?|specs?|plans?|migrations?|journals?|todo)(?:[.-]|$))/i;
const DATA_FILES = new Set([
  "aliases.json",
  "architectures.json",
  "asset-contracts.json",
  "contest-sources.json",
  "core-prs-allowlist.json",
  "core-prs.json",
  "cute-dsl-universe.json",
  "inclusion-policy.json",
  "pr-page-skipped.json",
  "refresh-cutoff.json",
  "refresh-search-results.json",
  "repository-budget.json",
  "schemas.json",
  "tags.json",
  "tool-release-receipt.json",
  "tool-versions.json",
  "triton-universe.json",
  "version-claims.json",
  "evidence/pr-architecture.json",
  "evidence/pr-file-cap-reconstruction.json",
]);
const FIXTURE_FILES = new Set([
  "ledger-shape-invalid.json",
  "ledger-shape-valid.json",
  "pr-page-cases.json",
  "pr-policy-cases.json",
]);

function hasDataOwner(relative) {
  if (relative.startsWith("data/")) {
    return DATA_FILES.has(relative.slice("data/".length));
  }
  if (relative.startsWith("tests/fixtures/")) {
    return FIXTURE_FILES.has(relative.slice("tests/fixtures/".length));
  }
  return /^candidates\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(relative);
}
const ROOT_PROCESS_NAME =
  /^(?:audit$|research-.*\.md$|(?:spec|plan|todo)\.md$|phase[-_]?\d|plan-phase)/i;

export function checkRepositoryHygiene(root = DEFAULT_ROOT) {
  const errors = [];
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name),
        rel = relative(file);
      if (PROCESS_NAME.test(entry.name)) {
        errors.push(`${rel}: use a domain name; keep development records under .dev/`);
      }
      if (entry.isDirectory()) {
        walk(file);
      } else if (!entry.isFile()) {
        errors.push(`${rel}: machine data must be a regular JSON file`);
      } else if (path.extname(entry.name) !== ".json") {
        errors.push(
          `${rel}: machine data must use JSON; place explanations in docs/ or references/`,
        );
      } else {
        if (!hasDataOwner(rel)) {
          errors.push(
            `${rel}: no declared product-data owner; register a consumed input or move it under .dev/`,
          );
        }
        try {
          readJson(file);
        } catch (error) {
          errors.push(`${rel}: invalid JSON (${error.message})`);
        }
      }
    }
  }
  for (const entry of fs.readdirSync(root)) {
    if (ROOT_PROCESS_NAME.test(entry)) {
      errors.push(`${entry}: development history belongs under .dev/`);
    }
  }
  for (const directory of MACHINE_DIRECTORIES) {
    let full = root;
    try {
      let regularPath = true;
      for (const part of directory.split("/")) {
        full = path.join(full, part);
        if (!fs.lstatSync(full).isDirectory()) {
          errors.push(
            `${relative(full)}: expected a regular machine-data directory, not a symlink`,
          );
          regularPath = false;
          break;
        }
      }
      if (regularPath) {
        walk(full);
      }
    } catch (error) {
      errors.push(`${directory}: cannot inspect machine data (${error.message})`);
    }
  }
  return errors.sort();
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string", default: DEFAULT_ROOT },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: node scripts/check-hygiene.mjs [--root PATH]\nCheck JSON data ownership and exclude development records from the product tree.",
      );
      return 0;
    }
    const errors = checkRepositoryHygiene(path.resolve(values.root));
    if (errors.length) {
      for (const error of errors) {
        console.error(`ERROR: ${error}`);
      }
      return 1;
    }
    console.log(
      "Repository hygiene passes: JSON machine data and no published development records.",
    );
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
