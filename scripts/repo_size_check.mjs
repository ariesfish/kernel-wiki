#!/usr/bin/env node
/** Report working-tree size and artifact file count, enforcing the active budget. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseMaintenance as parse } from "./_yaml.mjs";

const configured_root = process.env.BLACKWELL_WIKI_ROOT;
export const REPO_ROOT = configured_root
  ? path.resolve(configured_root === "~" ? os.homedir() : configured_root.replace(/^~\//, `${os.homedir()}/`))
  : path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const BUDGET_PATH = path.join(REPO_ROOT, "data", "phase3-size-budget.yaml");
export const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
export const EXCLUDE_TOP = new Set([".git", ".humanize", ".codex", ".cache", ".worklog", ".dev", "node_modules", ".venv", "venv", ".tox", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
export const EXCLUDE_ANY = new Set(["__pycache__"]);
export const FILE_COUNT_BUDGET = 6000;
const is_file = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const is_dir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function* walk_files(root, exclude = false, depth = 0) {
  if (!is_dir(root)) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (exclude && (EXCLUDE_ANY.has(entry.name) || (depth === 0 && EXCLUDE_TOP.has(entry.name)))) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk_files(full, exclude, depth + 1);
    // Like pathlib.rglob, count file symlinks but never recurse through directory symlinks.
    else if (entry.isFile() || (entry.isSymbolicLink() && is_file(full))) yield full;
  }
}

export function working_tree_bytes() {
  let total = 0, count = 0;
  for (const file of walk_files(REPO_ROOT, true)) {
    try { total += fs.statSync(file).size; count++; } catch { /* Race with scratch cleanup. */ }
  }
  return [total, count];
}

export function artifacts_file_count() {
  let count = 0;
  for (const file of walk_files(ARTIFACTS_DIR)) count++;
  return count;
}

export function load_budget() {
  if (!is_file(BUDGET_PATH)) return null;
  try { return parse(fs.readFileSync(BUDGET_PATH, "utf8")) || {}; }
  catch (e) { if (e.name === "YAMLParseError") return {}; throw e; }
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    // argparse accepts a negative integer as a separate value.
    const normalized = argv.flatMap((arg, i) => i > 0 && argv[i - 1] === "--ceiling-mib" && /^-\d+$/.test(arg) ? [] : arg === "--ceiling-mib" && /^-\d+$/.test(argv[i + 1] || "") ? [`${arg}=${argv[i + 1]}`] : [arg]);
    args = parseArgs({ args: normalized, options: { "ceiling-mib": { type: "string" }, help: { type: "boolean", short: "h" } } }).values;
    if (args.help) { console.log("Usage: repo_size_check.mjs [-h] [--ceiling-mib N]\nReport repo working-tree size and file count; fail if active ceiling exceeded."); return 0; }
    if (args["ceiling-mib"] !== undefined && (!/^[+-]?\d+$/.test(args["ceiling-mib"]) || !Number.isSafeInteger(Number(args["ceiling-mib"])))) throw new TypeError(`--ceiling-mib: invalid int value: '${args["ceiling-mib"]}'`);
  } catch (e) { console.error(`ERROR: ${e.message}`); return 2; }
  const [total, total_files] = working_tree_bytes();
  const artifacts_files = artifacts_file_count();
  const mib = total / (1024 * 1024);
  const budget = load_budget();
  let ceiling_mib = null, ceiling_src = null;
  if (args["ceiling-mib"] !== undefined) { ceiling_mib = Number(args["ceiling-mib"]); ceiling_src = "CLI override"; }
  else if (budget && Object.hasOwn(budget, "active_ceiling_mib")) { ceiling_mib = budget.active_ceiling_mib; ceiling_src = "data/phase3-size-budget.yaml"; }
  console.log(`Working tree: ${mib.toFixed(2)} MiB across ${total_files} files (artifacts/: ${artifacts_files} files)`);
  let failed = false;
  if (ceiling_mib !== null) {
    console.log(`Active ceiling: ${ceiling_mib} MiB (source: ${ceiling_src})`);
    if (mib > ceiling_mib) { console.error(`FAIL: working tree ${mib.toFixed(2)} MiB exceeds ceiling ${ceiling_mib} MiB`); failed = true; }
  } else console.log("Active ceiling: (no budget file present; skip size gate)");
  if (artifacts_files > FILE_COUNT_BUDGET) { console.error(`FAIL: artifacts/ has ${artifacts_files} files (> ${FILE_COUNT_BUDGET} budget)`); failed = true; }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
