#!/usr/bin/env node
/** Report working-tree size and artifact file count, enforcing the active budget. */
import { readJson } from "./lib/json.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const configuredRoot = process.env.BLACKWELL_WIKI_ROOT;
export const REPO_ROOT = configuredRoot
  ? path.resolve(
      configuredRoot === "~" ? os.homedir() : configuredRoot.replace(/^~\//, `${os.homedir()}/`),
    )
  : path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const BUDGET_PATH = path.join(REPO_ROOT, "data", "repository-budget.json");
export const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
export const EXCLUDE_TOP = new Set([
  ".git",
  ".humanize",
  ".codex",
  ".cache",
  ".worklog",
  ".dev",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
export const EXCLUDE_ANY = new Set(["__pycache__"]);
export const FILE_COUNT_BUDGET = 6000;
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
function* walkFiles(root, exclude = false, depth = 0) {
  if (!isDir(root)) {
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(root, {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (exclude && (EXCLUDE_ANY.has(entry.name) || (depth === 0 && EXCLUDE_TOP.has(entry.name)))) {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, exclude, depth + 1);
    }
    // Like pathlib.rglob, count file symlinks but never recurse through directory symlinks.
    else if (entry.isFile() || (entry.isSymbolicLink() && isFile(full))) {
      yield full;
    }
  }
}
export function workingTreeBytes() {
  let total = 0,
    count = 0;
  for (const file of walkFiles(REPO_ROOT, true)) {
    try {
      total += fs.statSync(file).size;
      count++;
    } catch {
      /* Race with scratch cleanup. */
    }
  }
  return [total, count];
}
export function artifactsFileCount() {
  return Array.from(walkFiles(ARTIFACTS_DIR)).length;
}
export function loadBudget() {
  if (!isFile(BUDGET_PATH)) {
    return null;
  }
  const budget = readJson(BUDGET_PATH);
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new TypeError("Repository budget must be a JSON object");
  }
  const ceiling = budget.active_ceiling_mib;
  const valid =
    typeof ceiling === "bigint"
      ? ceiling >= 0n
      : typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0;
  if (!Object.hasOwn(budget, "active_ceiling_mib") || !valid) {
    throw new TypeError("active_ceiling_mib must be a non-negative numeric ceiling");
  }
  return budget;
}
export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    // argparse accepts a negative integer as a separate value.
    const normalized = argv.flatMap((arg, i) =>
      i > 0 && argv[i - 1] === "--ceiling-mib" && /^-\d+$/.test(arg)
        ? []
        : arg === "--ceiling-mib" && /^-\d+$/.test(argv[i + 1] || "")
          ? [`${arg}=${argv[i + 1]}`]
          : [arg],
    );
    args = parseArgs({
      args: normalized,
      options: {
        "ceiling-mib": {
          type: "string",
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    }).values;
    if (args.help) {
      console.log(
        "Usage: repo-size-check.mjs [-h] [--ceiling-mib N]\nReport repo working-tree size and file count; fail if active ceiling exceeded.",
      );
      return 0;
    }
    if (
      args["ceiling-mib"] !== undefined &&
      (!/^[+-]?\d+$/.test(args["ceiling-mib"]) ||
        !Number.isSafeInteger(Number(args["ceiling-mib"])))
    ) {
      throw new TypeError(`--ceiling-mib: invalid int value: '${args["ceiling-mib"]}'`);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  const [total, totalFiles] = workingTreeBytes();
  const artifactsFiles = artifactsFileCount();
  const mib = total / (1024 * 1024);
  let budget;
  try {
    budget = loadBudget();
  } catch (error) {
    console.error(`ERROR: data/repository-budget.json: ${error.message}`);
    return 2;
  }
  let ceilingMib = null,
    ceilingSrc = null;
  if (args["ceiling-mib"] !== undefined) {
    ceilingMib = Number(args["ceiling-mib"]);
    ceilingSrc = "CLI override";
  } else if (budget && Object.hasOwn(budget, "active_ceiling_mib")) {
    ceilingMib = budget.active_ceiling_mib;
    ceilingSrc = "data/repository-budget.json";
  }
  console.log(
    `Working tree: ${mib.toFixed(2)} MiB across ${totalFiles} files (artifacts/: ${artifactsFiles} files)`,
  );
  let failed = false;
  if (ceilingMib !== null) {
    console.log(`Active ceiling: ${ceilingMib} MiB (source: ${ceilingSrc})`);
    if (mib > ceilingMib) {
      console.error(`FAIL: working tree ${mib.toFixed(2)} MiB exceeds ceiling ${ceilingMib} MiB`);
      failed = true;
    }
  } else {
    console.log("Active ceiling: (no budget file present; skip size gate)");
  }
  if (artifactsFiles > FILE_COUNT_BUDGET) {
    console.error(`FAIL: artifacts/ has ${artifactsFiles} files (> ${FILE_COUNT_BUDGET} budget)`);
    failed = true;
  }
  return failed ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
