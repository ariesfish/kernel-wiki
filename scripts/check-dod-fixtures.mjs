#!/usr/bin/env node
/** Check Phase 3 Definition-of-Done fixtures (AC-7), including contract-v3 identities. */
import { readJson } from "./lib/json.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseMaintenance as parse } from "./lib/yaml.mjs";
const configuredRoot = process.env.BLACKWELL_WIKI_ROOT;
export const REPO_ROOT = configuredRoot
  ? path.resolve(
      configuredRoot === "~" ? os.homedir() : configuredRoot.replace(/^~\//, `${os.homedir()}/`),
    )
  : path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const FIXTURES_PATH = path.join(REPO_ROOT, "data", "asset-contracts.json");
export const EXPECTED_V3_FIXTURE_ROSTER = Object.freeze({
  "blackwell-warp-specialization": "active",
  "deepgemm-nc128-promotion": "active",
  "cutlass-sm100-clc": "active",
  "nvfp4-batched-gemv": "retired",
  "flashattention4-software-exp": "retired",
});
const mapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const repr = (s) => {
  if (Array.isArray(s)) {
    return `[${s.map(repr).join(", ")}]`;
  }
  if (s === null || s === undefined) {
    return "None";
  }
  if (typeof s !== "string") {
    return String(s);
  }
  if (s.includes("'") && !s.includes('"')) {
    return JSON.stringify(s);
  }
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
};
const splitlines = (text) =>
  text
    ? text
        // eslint-disable-next-line no-control-regex -- Existing fixture text follows Python splitlines semantics.
        .split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
        .filter((_, i, a) => i < a.length - 1 || a[i] !== "")
    : [];
export function findBundleRootFor(filePath) {
  let current = path.dirname(path.resolve(filePath));
  while (current !== path.dirname(current)) {
    if (isFile(path.join(current, "PROVENANCE.yaml"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}
export function loadModesForFile(filePath) {
  const root = findBundleRootFor(filePath);
  if (!root) {
    return null;
  }
  let prov;
  try {
    prov = parse(fs.readFileSync(path.join(root, "PROVENANCE.yaml"), "utf8")) || {};
  } catch (e) {
    if (e.name === "YAMLParseError") {
      return null;
    }
    throw e;
  }
  const rel = path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
    return null;
  }
  for (const entry of prov.files || []) {
    if (mapping(entry) && entry.local_path === rel) {
      return entry.mode ?? null;
    }
  }
  return null;
}
export function loadBundleModeForFile(filePath) {
  const root = findBundleRootFor(filePath);
  if (!root) {
    return null;
  }
  let prov;
  try {
    prov = parse(fs.readFileSync(path.join(root, "PROVENANCE.yaml"), "utf8")) || {};
  } catch (e) {
    if (e.name === "YAMLParseError") {
      return null;
    }
    throw e;
  }
  return prov.asset_mode ?? null;
}
export function checkEntry(entry) {
  const errors = [];
  const question = entry.question ?? "<unnamed>";
  const requiredAssets = entry.required_assets || [];
  const requiredMinLines = entry.required_min_lines ?? 100;
  const requiredModes = new Set(entry.required_provenance_modes || []);
  const requiredBundleModes = new Set(entry.required_bundle_asset_mode || []);
  const requiredPatterns = entry.required_content_patterns || [];
  const perGlob = new Map();
  for (const asset of requiredAssets) {
    const glob = mapping(asset) ? asset.glob : asset;
    const minLines = mapping(asset) ? (asset.min_lines ?? requiredMinLines) : requiredMinLines;
    if (!glob) {
      continue;
    }
    const hits = [
      ...fs.globSync(glob, {
        cwd: REPO_ROOT,
      }),
    ]
      .map((p) => path.join(REPO_ROOT, p))
      .filter(isFile);
    perGlob.set(glob, {
      hits,
      min_lines: minLines,
    });
    if (!hits.length) {
      errors.push(`${repr(question)}: required_assets glob ${repr(glob)} matched no files`);
    }
  }
  if (errors.length) {
    return errors;
  }
  for (const [glob, { hits, min_lines: minLines }] of perGlob) {
    const enough = hits.some((p) => {
      try {
        return splitlines(fs.readFileSync(p, "utf8")).length >= minLines;
      } catch {
        return false;
      }
    });
    if (!enough) {
      errors.push(
        `${repr(question)}: no file matching ${repr(glob)} reached required_min_lines=${minLines}`,
      );
    }
  }
  if (requiredModes.size) {
    for (const [glob, { hits }] of perGlob) {
      if (!hits.some((p) => requiredModes.has(loadModesForFile(p)))) {
        errors.push(
          `${repr(question)}: no file matching ${repr(glob)} has per-file provenance mode in ${repr([...requiredModes].sort())}`,
        );
      }
    }
  }
  if (requiredBundleModes.size) {
    for (const [glob, { hits }] of perGlob) {
      if (!hits.some((p) => requiredBundleModes.has(loadBundleModeForFile(p)))) {
        errors.push(
          `${repr(question)}: no file matching ${repr(glob)} lives in a bundle with asset_mode in ${repr([...requiredBundleModes].sort())}`,
        );
      }
    }
  }
  if (requiredPatterns.length) {
    let aggregate = "";
    for (const { hits } of perGlob.values()) {
      for (const p of hits) {
        try {
          aggregate += `${fs.readFileSync(p, "utf8")}\n`;
        } catch {
          /* Unreadable evidence contributes no content. */
        }
      }
    }
    for (const pat of requiredPatterns) {
      try {
        let flags = "i";
        const source = pat
          .replace(/^\(\?([ims]+)\)/, (_, inline) => {
            flags = [...new Set(flags + inline)].join("");
            return "";
          })
          .replace(/\(\?P</g, "(?<");
        if (!new RegExp(source, flags).test(aggregate)) {
          errors.push(`${repr(question)}: required_content_pattern ${repr(pat)} not found`);
        }
      } catch (e) {
        errors.push(`${repr(question)}: invalid regex ${repr(pat)}: ${e.message}`);
      }
    }
  }
  return errors;
}
export function checkRetiredEntry(entry) {
  if (!mapping(entry)) {
    return ["retired fixture entry must be a mapping"];
  }
  const question = entry.question ?? "<unnamed>";
  const errors = [];
  if (!String(entry.reason || "").trim()) {
    errors.push(`${repr(question)}: retired fixture requires a non-empty reason`);
  }
  if (!String(entry.retired_at || "").trim()) {
    errors.push(`${repr(question)}: retired fixture requires retired_at`);
  }
  if (!Array.isArray(entry.former_required_assets) || !entry.former_required_assets.length) {
    errors.push(`${repr(question)}: retired fixture requires former_required_assets`);
  }
  if (
    entry.required_assets &&
    (!Array.isArray(entry.required_assets) || entry.required_assets.length)
  ) {
    errors.push(`${repr(question)}: retired fixture cannot carry active required_assets`);
  }
  return errors;
}
export function checkFixtureContract(data) {
  const errors = [];
  if (!mapping(data)) {
    return ["fixture contract must be a mapping"];
  }
  if (data.contract_version !== 3) {
    errors.push("fixture contract_version must be 3");
  }
  const roster = data.fixture_roster;
  if (!mapping(roster) || !Object.keys(roster).length) {
    return [...errors, "fixture_roster must be a non-empty mapping"];
  }
  const missing = Object.keys(EXPECTED_V3_FIXTURE_ROSTER)
    .filter((id) => !Object.hasOwn(roster, id))
    .sort();
  const extra = Object.keys(roster)
    .filter((id) => !Object.hasOwn(EXPECTED_V3_FIXTURE_ROSTER, id))
    .sort();
  const drift = Object.keys(roster)
    .filter(
      (id) =>
        Object.hasOwn(EXPECTED_V3_FIXTURE_ROSTER, id) &&
        roster[id] !== EXPECTED_V3_FIXTURE_ROSTER[id],
    )
    .sort();
  if (missing.length || extra.length || drift.length) {
    errors.push(
      `fixture_roster differs from pinned contract-v3 identities: missing=${repr(missing)}, extra=${repr(extra)}, state_drift=${repr(drift)}`,
    );
  }
  const expected = {
    active: new Set(),
    retired: new Set(),
  };
  for (const [id, state] of Object.entries(roster)) {
    if (!id.trim()) {
      errors.push("fixture_roster ids must be non-empty strings");
      continue;
    }
    if (!Object.hasOwn(expected, state)) {
      errors.push(
        `fixture_roster[${repr(id)}] has invalid state ${repr(state)}; expected active or retired`,
      );
      continue;
    }
    expected[state].add(id);
  }
  const actual = {
    active: new Set(),
    retired: new Set(),
  };
  for (const [state, key] of [
    ["active", "fixtures"],
    ["retired", "retired_fixtures"],
  ]) {
    const rows = data[key] || [];
    if (!Array.isArray(rows)) {
      errors.push(`${key} must be a list`);
      continue;
    }
    for (const [index, entry] of rows.entries()) {
      if (!mapping(entry)) {
        errors.push(`${key}[${index}] must be a mapping`);
        continue;
      }
      const id = entry.id;
      if (typeof id !== "string" || !id.trim()) {
        errors.push(`${key}[${index}] requires a non-empty id`);
        continue;
      }
      if (actual[state].has(id)) {
        errors.push(`${key} contains duplicate id ${repr(id)}`);
      }
      actual[state].add(id);
    }
  }
  for (const state of ["active", "retired"]) {
    const missing = [...expected[state]].filter((id) => !actual[state].has(id)).sort();
    const extra = [...actual[state]].filter((id) => !expected[state].has(id)).sort();
    if (missing.length) {
      errors.push(`fixture_roster ${state} ids missing from entries: ${repr(missing)}`);
    }
    if (extra.length) {
      errors.push(`${state} entry ids absent from fixture_roster: ${repr(extra)}`);
    }
  }
  const overlap = [...actual.active].filter((id) => actual.retired.has(id)).sort();
  if (overlap.length) {
    errors.push(`fixture ids cannot be both active and retired: ${repr(overlap)}`);
  }
  return errors;
}
export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        help: {
          type: "boolean",
          short: "h",
        },
      },
    }).values;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  if (args.help) {
    console.log(
      "Usage: check-dod-fixtures.mjs [-h]\nCheck Phase 3 Definition-of-Done fixtures (AC-7).",
    );
    return 0;
  }
  if (!isFile(FIXTURES_PATH)) {
    console.error(
      `ERROR: ${path.relative(REPO_ROOT, FIXTURES_PATH)} not found; the AC-7 DoD fixture gate requires this file. If the gate is intentionally being retired, remove the invocation from the pre-commit hook and delete this script instead of deleting the fixtures file.`,
    );
    return 2;
  }
  let data;
  try {
    data = readJson(FIXTURES_PATH) || {};
  } catch (e) {
    console.error(`ERROR: could not parse ${FIXTURES_PATH}: ${e.message}`);
    return 2;
  }
  const entries = data.fixtures || [];
  if (Array.isArray(entries) && !entries.length) {
    console.error(
      `ERROR: ${path.relative(REPO_ROOT, FIXTURES_PATH)} has no \`fixtures:\` entries; AC-7 requires at least one fixture.`,
    );
    return 2;
  }
  const retired = data.retired_fixtures || [];
  const errors = checkFixtureContract(data);
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (mapping(entry)) {
        errors.push(...checkEntry(entry));
      }
    }
  }
  if (Array.isArray(retired)) {
    for (const entry of retired) {
      errors.push(...checkRetiredEntry(entry));
    }
  }
  console.log(
    `Checked ${Array.isArray(entries) ? entries.length : 0} active and ${Array.isArray(retired) ? retired.length : 0} retired DoD fixture entries.`,
  );
  if (errors.length) {
    for (const error of errors) {
      console.error(`  FAIL: ${error}`);
    }
    return 1;
  }
  console.log("All fixtures pass.");
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
