#!/usr/bin/env node
/** Offline freshness checker. Reads checked-in inputs only; no network or subprocess APIs. */
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
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const CANDIDATES_DIR = path.join(REPO_ROOT, "candidates");
export const DEFAULT_VERSION_STALENESS_DAYS = 180;
export const DEFAULT_LEDGER_STALENESS_DAYS = 30;
const DAY = 86_400_000;
const mapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const is_file = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const entries = (p) => { try { return fs.readdirSync(p).sort(); } catch (e) { if (e.code === "ENOENT") return []; throw e; } };
const iso = (date) => date.toISOString().slice(0, 10);
const py_str = (v) => v == null ? "None" : v instanceof Date ? iso(v) : String(v);
const repr = (v) => {
  if (v == null) return "None";
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  if (typeof v !== "string") return py_str(v);
  if (v.includes("'") && !v.includes('"')) return JSON.stringify(v);
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
};
const display_pairs = (pairs) => `[${pairs.map((key) => `(${JSON.parse(key).map(repr).join(", ")})`).join(", ")}]`;
const sorted_pairs = (pairs) => [...pairs].sort((a, b) => {
  const x = JSON.parse(a), y = JSON.parse(b);
  return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
});

export function load_yaml(file_path) {
  if (!is_file(file_path)) return null;
  return parse(fs.readFileSync(file_path, "utf8"));
}

/** Return a UTC-midnight Date. Reject impossible dates instead of rolling them over. */
export function parse_iso(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new RangeError("Invalid date");
    return parse_iso(iso(value));
  }
  const text = String(value);
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) || /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    const [, y, m, d] = match;
    if (+y < 1) throw new RangeError(`Invalid isoformat string: ${repr(text)}`);
    const result = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
    if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() !== +y || result.getUTCMonth() + 1 !== +m || result.getUTCDate() !== +d) throw new RangeError(`Invalid isoformat string: ${repr(text)}`);
    return result;
  }
  // date.fromisoformat also accepts ISO week dates, with Monday as the default.
  match = /^(\d{4})-W(\d{2})(?:-([1-7]))?$/.exec(text) || /^(\d{4})W(\d{2})([1-7])?$/.exec(text);
  if (match) {
    const [, year, week, day = "1"] = match;
    const jan4 = parse_iso(`${year}-01-04`);
    const monday = +jan4 - ((jan4.getUTCDay() + 6) % 7) * DAY;
    const result = new Date(monday + ((+week - 1) * 7 + +day - 1) * DAY);
    const thursday = new Date(monday + ((+week - 1) * 7 + 3) * DAY);
    if (+week >= 1 && +week <= 53 && thursday.getUTCFullYear() === +year && result.getUTCFullYear() >= 1 && result.getUTCFullYear() <= 9999) return result;
  }
  throw new RangeError(`Invalid isoformat string: ${repr(text)}`);
}

export function is_superseded(plan_path) {
  if (!is_file(plan_path)) return false;
  return fs.readFileSync(plan_path, "utf8").split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).slice(0, 3).some((line) => /^>\s*Superseded by/i.test(line));
}

export function* check_tool_versions(tool_versions, today, version_staleness_days) {
  today = parse_iso(today);
  const threshold = +today - version_staleness_days * DAY;
  for (const tool of tool_versions.tools || []) {
    const checked_at = tool.upstream_checked_at;
    let checked_date = null;
    if (checked_at == null) yield ["warn", `tool-versions: ${tool.tool} missing upstream_checked_at`];
    else {
      try {
        checked_date = parse_iso(checked_at);
        if (+checked_date < threshold) yield ["warn", `tool-versions: ${tool.tool} upstream_checked_at=${iso(checked_date)} (${(+today - checked_date) / DAY}d ago, >= ${version_staleness_days}d threshold)`];
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        yield ["warn", `tool-versions: ${tool.tool} has unparseable upstream_checked_at=${repr(checked_at)}`];
      }
    }
    for (const rel of tool.releases || []) {
      const name = rel.name ?? "?";
      const ra = rel.released_at;
      if (ra == null || ra === "needs-verification") {
        yield ["warn", `tool-versions: ${tool.tool} ${name} has released_at=${repr(ra)} (needs-verification)`];
        continue;
      }
      let ra_date;
      try { ra_date = parse_iso(ra); }
      catch (e) {
        if (!(e instanceof RangeError)) throw e;
        yield ["warn", `tool-versions: ${tool.tool} ${name} has unparseable released_at=${repr(ra)}`];
        continue;
      }
      if (checked_date && ra_date > checked_date) yield ["warn", `tool-versions: ${tool.tool} ${name} released_at=${iso(ra_date)} is newer than upstream_checked_at=${iso(checked_date)}`];
      if (+ra_date < threshold) yield ["info", `tool-versions: ${tool.tool} ${name} released ${(+today - ra_date) / DAY}d ago (>= ${version_staleness_days}d staleness threshold)`];
    }
  }
}

// JSON pair keys give Set the same value equality as Python's tuple sets.
export function _registry_release_pairs(tool) {
  const pairs = new Set();
  for (const release of tool.releases || []) {
    let released_at;
    try { released_at = iso(parse_iso(release.released_at)); }
    catch (e) { if (!(e instanceof RangeError || e instanceof TypeError)) throw e; released_at = py_str(release.released_at); }
    pairs.add(JSON.stringify([py_str(Object.hasOwn(release, "name") ? release.name : ""), released_at]));
  }
  return pairs;
}

export function _receipt_release_pairs(tool_name, receipt_tool) {
  const pairs = new Set();
  for (const [index, row] of (receipt_tool.releases || []).entries()) {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError(`${tool_name} releases[${index}] must be [name, released_at]`);
    pairs.add(JSON.stringify([py_str(row[0]), iso(parse_iso(row[1]))]));
  }
  return pairs;
}

export function* check_release_receipt(tool_versions, receipt) {
  if (!mapping(receipt)) { yield ["warn", "tool-release-receipt: missing or invalid receipt"]; return; }
  const receipt_tools = receipt.tools;
  if (!mapping(receipt_tools)) { yield ["warn", "tool-release-receipt: tools must be a mapping"]; return; }
  const registry_tools = new Map((tool_versions.tools || []).filter((tool) => mapping(tool) && tool.tool).map((tool) => [String(tool.tool), tool]));
  for (const [name, tool] of [...registry_tools].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const received = Object.hasOwn(receipt_tools, name) ? receipt_tools[name] : null;
    if (!mapping(received)) { yield ["warn", `tool-release-receipt: missing receipt for ${name}`]; continue; }
    const registry_checked = py_str(tool.upstream_checked_at ?? (Object.hasOwn(tool, "upstream_checked_at") ? null : ""));
    const receipt_checked = py_str(received.upstream_checked_at ?? (Object.hasOwn(received, "upstream_checked_at") ? null : ""));
    if (registry_checked !== receipt_checked) yield ["warn", `tool-release-receipt: ${name} upstream_checked_at mismatch registry=${repr(registry_checked)} receipt=${repr(receipt_checked)}`];
    let receipt_pairs;
    try { receipt_pairs = _receipt_release_pairs(name, received); }
    catch (e) { if (!(e instanceof TypeError || e instanceof RangeError)) throw e; yield ["warn", `tool-release-receipt: ${e.message}`]; continue; }
    const registry_pairs = _registry_release_pairs(tool);
    const missing = sorted_pairs([...receipt_pairs].filter((p) => !registry_pairs.has(p)));
    const unreceipted = sorted_pairs([...registry_pairs].filter((p) => !receipt_pairs.has(p)));
    if (missing.length) yield ["warn", `tool-release-receipt: ${name} registry missing receipted releases ${display_pairs(missing)}`];
    if (unreceipted.length) yield ["warn", `tool-release-receipt: ${name} has unreceipted releases ${display_pairs(unreceipted)}`];
  }
  const extra = Object.keys(receipt_tools).filter((name) => !registry_tools.has(name)).sort();
  if (extra.length) yield ["warn", `tool-release-receipt: receipts without registry tools ${repr(extra)}`];
}

export function* check_version_claims(claims_data, tool_versions, today, version_staleness_days) {
  if (claims_data == null) return;
  today = parse_iso(today);
  const threshold = +today - version_staleness_days * DAY;
  const known = new Set();
  for (const tool of tool_versions.tools || []) for (const rel of tool.releases || []) known.add(rel.name);
  for (const claim of claims_data.claims || []) {
    const cid = claim.id ?? "?";
    const verified_at = claim.last_verified_at;
    const release = claim.last_verified_release;
    if (verified_at == null) yield ["warn", `version-claims: ${cid} missing last_verified_at`];
    else {
      try {
        const date = parse_iso(verified_at);
        if (+date < threshold) yield ["warn", `version-claims: ${cid} last_verified_at=${iso(date)} (${(+today - date) / DAY}d ago, >= ${version_staleness_days}d threshold)`];
      } catch (e) { if (!(e instanceof RangeError)) throw e; yield ["warn", `version-claims: ${cid} unparseable last_verified_at=${repr(verified_at)}`]; }
    }
    if (release && !known.has(release)) yield ["warn", `version-claims: ${cid} last_verified_release=${repr(release)} not in data/tool-versions.yaml`];
  }
}

export function* check_ledger_freshness(today, ledger_staleness_days, refresh_cutoff) {
  today = parse_iso(today);
  if (refresh_cutoff) refresh_cutoff = parse_iso(refresh_cutoff);
  const threshold = +today - ledger_staleness_days * DAY;
  for (const name of entries(CANDIDATES_DIR).filter((name) => name.endsWith(".yaml"))) {
    const data = load_yaml(path.join(CANDIDATES_DIR, name));
    if (!mapping(data)) continue;
    const sa = data.searched_at;
    if (sa == null) { yield ["warn", `ledger ${name}: missing searched_at`]; continue; }
    let date;
    try { date = parse_iso(sa); }
    catch (e) { if (!(e instanceof RangeError)) throw e; yield ["warn", `ledger ${name}: unparseable searched_at=${repr(sa)}`]; continue; }
    if (refresh_cutoff && +date !== +refresh_cutoff) yield ["info", `ledger ${name}: searched_at=${iso(date)} disagrees with refresh-cutoff ${iso(refresh_cutoff)}`];
    else if (!refresh_cutoff && +date < threshold) yield ["warn", `ledger ${name}: searched_at=${iso(date)} (${(+today - date) / DAY}d ago, >= ${ledger_staleness_days}d threshold)`];
  }
}

export function* check_supersession(today) {
  for (const name of entries(REPO_ROOT).filter((name) => /^plan-phase.*\.md$/.test(name))) {
    const superseded = is_superseded(path.join(REPO_ROOT, name));
    if (name === "plan-phase4.md") {
      if (superseded) yield ["warn", `${name}: current-round plan should not be superseded`];
    } else if (!superseded) yield ["warn", `${name}: missing supersession header in first 3 lines (AC-9)`];
  }
}

export function main(argv = process.argv.slice(2)) {
  let args, today, version_days, ledger_days;
  try {
    const numeric_flags = new Set(["--version-staleness-days", "--ledger-staleness-days"]);
    const normalized = argv.flatMap((arg, i) => i > 0 && numeric_flags.has(argv[i - 1]) && /^-\d+$/.test(arg) ? [] : numeric_flags.has(arg) && /^-\d+$/.test(argv[i + 1] || "") ? [`${arg}=${argv[i + 1]}`] : [arg]);
    args = parseArgs({ args: normalized, options: {
      strict: { type: "boolean" }, today: { type: "string" },
      "version-staleness-days": { type: "string", default: String(DEFAULT_VERSION_STALENESS_DAYS) },
      "ledger-staleness-days": { type: "string", default: String(DEFAULT_LEDGER_STALENESS_DAYS) },
      help: { type: "boolean", short: "h" },
    } }).values;
    if (args.help) {
      console.log("Usage: check_version_freshness.mjs [-h] [--strict] [--today YYYY-MM-DD] [--version-staleness-days N] [--ledger-staleness-days N]\nOffline freshness checker for KernelWiki. Default mode is advisory; --strict exits 1 on warnings.");
      return 0;
    }
    for (const key of ["version-staleness-days", "ledger-staleness-days"]) if (!/^[+-]?\d+$/.test(args[key]) || !Number.isSafeInteger(Number(args[key]))) throw new TypeError(`--${key}: invalid int value: ${repr(args[key])}`);
    version_days = Number(args["version-staleness-days"]);
    ledger_days = Number(args["ledger-staleness-days"]);
  } catch (e) { console.error(`ERROR: ${e.message}`); return 2; }
  try {
    const now = new Date();
    today = args.today ? parse_iso(args.today) : parse_iso(`${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
  } catch (e) { console.error(`ERROR: ${e.message}`); return 1; }
  const tool_versions = load_yaml(path.join(DATA_DIR, "tool-versions.yaml")) || {};
  const receipt = load_yaml(path.join(DATA_DIR, "tool-release-receipt.yaml"));
  const claims = load_yaml(path.join(DATA_DIR, "version-claims.yaml")) || {};
  const cutoff_data = load_yaml(path.join(DATA_DIR, "refresh-cutoff.yaml"));
  let cutoff = null;
  if (cutoff_data && Object.hasOwn(cutoff_data, "cutoff_date")) {
    try { cutoff = parse_iso(cutoff_data.cutoff_date); }
    catch (e) { if (!(e instanceof RangeError)) throw e; console.error(`WARN: data/refresh-cutoff.yaml::cutoff_date is unparseable: ${repr(cutoff_data.cutoff_date)}`); }
  }
  const findings = [
    ...check_tool_versions(tool_versions, today, version_days), ...check_release_receipt(tool_versions, receipt),
    ...check_version_claims(claims, tool_versions, today, version_days), ...check_ledger_freshness(today, ledger_days, cutoff),
    ...check_supersession(today),
  ];
  const warns = findings.filter(([severity]) => severity === "warn").map(([, message]) => message);
  const infos = findings.filter(([severity]) => severity === "info").map(([, message]) => message);
  console.log(`check_version_freshness.mjs — today=${iso(today)}, version-staleness=${version_days}d, ledger-staleness=${ledger_days}d`);
  console.log(`  ${warns.length} warnings, ${infos.length} info messages`);
  for (const message of warns) console.log(`  WARN: ${message}`);
  for (const message of infos) console.log(`  INFO: ${message}`);
  if (args.strict && warns.length) { console.error(`\n--strict: ${warns.length} warning(s) -> exit 1`); return 1; }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
