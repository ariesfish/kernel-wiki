#!/usr/bin/env node
/** Offline freshness checker. Reads checked-in inputs only; no network or subprocess APIs. */
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
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const CANDIDATES_DIR = path.join(REPO_ROOT, "candidates");
export const DEFAULT_VERSION_STALENESS_DAYS = 180;
export const DEFAULT_LEDGER_STALENESS_DAYS = 30;
const DAY = 86_400_000;
const mapping = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const entries = (p) => {
  try {
    return fs.readdirSync(p).sort();
  } catch (e) {
    if (e.code === "ENOENT") {
      return [];
    }
    throw e;
  }
};
const iso = (date) => date.toISOString().slice(0, 10);
const pyStr = (v) => (v == null ? "None" : v instanceof Date ? iso(v) : String(v));
const repr = (v) => {
  if (v == null) {
    return "None";
  }
  if (Array.isArray(v)) {
    return `[${v.map(repr).join(", ")}]`;
  }
  if (typeof v !== "string") {
    return pyStr(v);
  }
  if (v.includes("'") && !v.includes('"')) {
    return JSON.stringify(v);
  }
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;
};
const displayPairs = (pairs) =>
  `[${pairs.map((key) => `(${JSON.parse(key).map(repr).join(", ")})`).join(", ")}]`;
const sortedPairs = (pairs) =>
  [...pairs].sort((a, b) => {
    const x = JSON.parse(a),
      y = JSON.parse(b);
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  });
export function loadJson(filePath) {
  if (!isFile(filePath)) {
    return null;
  }
  return readJson(filePath);
}

/** Return a UTC-midnight Date. Reject impossible dates instead of rolling them over. */
export function parseIso(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new RangeError("Invalid date");
    }
    return parseIso(iso(value));
  }
  const text = String(value);
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) || /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    const [, y, m, d] = match;
    if (+y < 1) {
      throw new RangeError(`Invalid isoformat string: ${repr(text)}`);
    }
    const result = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
    if (
      !Number.isFinite(result.getTime()) ||
      result.getUTCFullYear() !== +y ||
      result.getUTCMonth() + 1 !== +m ||
      result.getUTCDate() !== +d
    ) {
      throw new RangeError(`Invalid isoformat string: ${repr(text)}`);
    }
    return result;
  }
  // date.fromisoformat also accepts ISO week dates, with Monday as the default.
  match = /^(\d{4})-W(\d{2})(?:-([1-7]))?$/.exec(text) || /^(\d{4})W(\d{2})([1-7])?$/.exec(text);
  if (match) {
    const [, year, week, day = "1"] = match;
    const jan4 = parseIso(`${year}-01-04`);
    const monday = +jan4 - ((jan4.getUTCDay() + 6) % 7) * DAY;
    const result = new Date(monday + ((+week - 1) * 7 + +day - 1) * DAY);
    const thursday = new Date(monday + ((+week - 1) * 7 + 3) * DAY);
    if (
      +week >= 1 &&
      +week <= 53 &&
      thursday.getUTCFullYear() === +year &&
      result.getUTCFullYear() >= 1 &&
      result.getUTCFullYear() <= 9999
    ) {
      return result;
    }
  }
  throw new RangeError(`Invalid isoformat string: ${repr(text)}`);
}
export function* checkToolVersions(toolVersions, today, versionStalenessDays) {
  today = parseIso(today);
  const threshold = +today - versionStalenessDays * DAY;
  for (const tool of toolVersions.tools || []) {
    const checkedAt = tool.upstream_checked_at;
    let checkedDate = null;
    if (checkedAt == null) {
      yield ["warn", `tool-versions: ${tool.tool} missing upstream_checked_at`];
    } else {
      try {
        checkedDate = parseIso(checkedAt);
        if (+checkedDate < threshold) {
          yield [
            "warn",
            `tool-versions: ${tool.tool} upstream_checked_at=${iso(checkedDate)} (${(+today - checkedDate) / DAY}d ago, >= ${versionStalenessDays}d threshold)`,
          ];
        }
      } catch (e) {
        if (!(e instanceof RangeError)) {
          throw e;
        }
        yield [
          "warn",
          `tool-versions: ${tool.tool} has unparseable upstream_checked_at=${repr(checkedAt)}`,
        ];
      }
    }
    for (const rel of tool.releases || []) {
      const name = rel.name ?? "?";
      const ra = rel.released_at;
      if (ra == null || ra === "needs-verification") {
        yield [
          "warn",
          `tool-versions: ${tool.tool} ${name} has released_at=${repr(ra)} (needs-verification)`,
        ];
        continue;
      }
      let raDate;
      try {
        raDate = parseIso(ra);
      } catch (e) {
        if (!(e instanceof RangeError)) {
          throw e;
        }
        yield [
          "warn",
          `tool-versions: ${tool.tool} ${name} has unparseable released_at=${repr(ra)}`,
        ];
        continue;
      }
      if (checkedDate && raDate > checkedDate) {
        yield [
          "warn",
          `tool-versions: ${tool.tool} ${name} released_at=${iso(raDate)} is newer than upstream_checked_at=${iso(checkedDate)}`,
        ];
      }
      if (+raDate < threshold) {
        yield [
          "info",
          `tool-versions: ${tool.tool} ${name} released ${(+today - raDate) / DAY}d ago (>= ${versionStalenessDays}d staleness threshold)`,
        ];
      }
    }
  }
}

// JSON pair keys give Set the same value equality as Python's tuple sets.
export function registryReleasePairs(tool) {
  const pairs = new Set();
  for (const release of tool.releases || []) {
    let releasedAt;
    try {
      releasedAt = iso(parseIso(release.released_at));
    } catch (e) {
      if (!(e instanceof RangeError || e instanceof TypeError)) {
        throw e;
      }
      releasedAt = pyStr(release.released_at);
    }
    pairs.add(
      JSON.stringify([pyStr(Object.hasOwn(release, "name") ? release.name : ""), releasedAt]),
    );
  }
  return pairs;
}
export function receiptReleasePairs(toolName, receiptTool) {
  const pairs = new Set();
  for (const [index, row] of (receiptTool.releases || []).entries()) {
    if (!Array.isArray(row) || row.length !== 2) {
      throw new TypeError(`${toolName} releases[${index}] must be [name, released_at]`);
    }
    pairs.add(JSON.stringify([pyStr(row[0]), iso(parseIso(row[1]))]));
  }
  return pairs;
}
export function* checkReleaseReceipt(toolVersions, receipt) {
  if (!mapping(receipt)) {
    yield ["warn", "tool-release-receipt: missing or invalid receipt"];
    return;
  }
  const receiptTools = receipt.tools;
  if (!mapping(receiptTools)) {
    yield ["warn", "tool-release-receipt: tools must be a mapping"];
    return;
  }
  const registryTools = new Map(
    (toolVersions.tools || [])
      .filter((tool) => mapping(tool) && tool.tool)
      .map((tool) => [String(tool.tool), tool]),
  );
  for (const [name, tool] of [...registryTools].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const received = Object.hasOwn(receiptTools, name) ? receiptTools[name] : null;
    if (!mapping(received)) {
      yield ["warn", `tool-release-receipt: missing receipt for ${name}`];
      continue;
    }
    const registryChecked = pyStr(
      tool.upstream_checked_at ?? (Object.hasOwn(tool, "upstream_checked_at") ? null : ""),
    );
    const receiptChecked = pyStr(
      received.upstream_checked_at ?? (Object.hasOwn(received, "upstream_checked_at") ? null : ""),
    );
    if (registryChecked !== receiptChecked) {
      yield [
        "warn",
        `tool-release-receipt: ${name} upstream_checked_at mismatch registry=${repr(registryChecked)} receipt=${repr(receiptChecked)}`,
      ];
    }
    let receiptPairs;
    try {
      receiptPairs = receiptReleasePairs(name, received);
    } catch (e) {
      if (!(e instanceof TypeError || e instanceof RangeError)) {
        throw e;
      }
      yield ["warn", `tool-release-receipt: ${e.message}`];
      continue;
    }
    const registryPairs = registryReleasePairs(tool);
    const missing = sortedPairs([...receiptPairs].filter((p) => !registryPairs.has(p)));
    const unreceipted = sortedPairs([...registryPairs].filter((p) => !receiptPairs.has(p)));
    if (missing.length) {
      yield [
        "warn",
        `tool-release-receipt: ${name} registry missing receipted releases ${displayPairs(missing)}`,
      ];
    }
    if (unreceipted.length) {
      yield [
        "warn",
        `tool-release-receipt: ${name} has unreceipted releases ${displayPairs(unreceipted)}`,
      ];
    }
  }
  const extra = Object.keys(receiptTools)
    .filter((name) => !registryTools.has(name))
    .sort();
  if (extra.length) {
    yield ["warn", `tool-release-receipt: receipts without registry tools ${repr(extra)}`];
  }
}
export function* checkVersionClaims(claimsData, toolVersions, today, versionStalenessDays) {
  if (claimsData == null) {
    return;
  }
  today = parseIso(today);
  const threshold = +today - versionStalenessDays * DAY;
  const known = new Set();
  for (const tool of toolVersions.tools || []) {
    for (const rel of tool.releases || []) {
      known.add(rel.name);
    }
  }
  for (const claim of claimsData.claims || []) {
    const cid = claim.id ?? "?";
    const verifiedAt = claim.last_verified_at;
    const release = claim.last_verified_release;
    if (verifiedAt == null) {
      yield ["warn", `version-claims: ${cid} missing last_verified_at`];
    } else {
      try {
        const date = parseIso(verifiedAt);
        if (+date < threshold) {
          yield [
            "warn",
            `version-claims: ${cid} last_verified_at=${iso(date)} (${(+today - date) / DAY}d ago, >= ${versionStalenessDays}d threshold)`,
          ];
        }
      } catch (e) {
        if (!(e instanceof RangeError)) {
          throw e;
        }
        yield ["warn", `version-claims: ${cid} unparseable last_verified_at=${repr(verifiedAt)}`];
      }
    }
    if (release && !known.has(release)) {
      yield [
        "warn",
        `version-claims: ${cid} last_verified_release=${repr(release)} not in data/tool-versions.json`,
      ];
    }
  }
}
export function* checkLedgerFreshness(today, ledgerStalenessDays, refreshCutoff) {
  today = parseIso(today);
  if (refreshCutoff) {
    refreshCutoff = parseIso(refreshCutoff);
  }
  const threshold = +today - ledgerStalenessDays * DAY;
  for (const name of entries(CANDIDATES_DIR).filter((name) => name.endsWith(".json"))) {
    const data = loadJson(path.join(CANDIDATES_DIR, name));
    if (!mapping(data)) {
      continue;
    }
    const sa = data.searched_at;
    if (sa == null) {
      yield ["warn", `ledger ${name}: missing searched_at`];
      continue;
    }
    let date;
    try {
      date = parseIso(sa);
    } catch (e) {
      if (!(e instanceof RangeError)) {
        throw e;
      }
      yield ["warn", `ledger ${name}: unparseable searched_at=${repr(sa)}`];
      continue;
    }
    if (refreshCutoff && +date !== +refreshCutoff) {
      yield [
        "info",
        `ledger ${name}: searched_at=${iso(date)} disagrees with refresh-cutoff ${iso(refreshCutoff)}`,
      ];
    } else if (!refreshCutoff && +date < threshold) {
      yield [
        "warn",
        `ledger ${name}: searched_at=${iso(date)} (${(+today - date) / DAY}d ago, >= ${ledgerStalenessDays}d threshold)`,
      ];
    }
  }
}
export function main(argv = process.argv.slice(2)) {
  let args, today, versionDays, ledgerDays;
  try {
    const numericFlags = new Set(["--version-staleness-days", "--ledger-staleness-days"]);
    const normalized = argv.flatMap((arg, i) =>
      i > 0 && numericFlags.has(argv[i - 1]) && /^-\d+$/.test(arg)
        ? []
        : numericFlags.has(arg) && /^-\d+$/.test(argv[i + 1] || "")
          ? [`${arg}=${argv[i + 1]}`]
          : [arg],
    );
    args = parseArgs({
      args: normalized,
      options: {
        strict: {
          type: "boolean",
        },
        today: {
          type: "string",
        },
        "version-staleness-days": {
          type: "string",
          default: String(DEFAULT_VERSION_STALENESS_DAYS),
        },
        "ledger-staleness-days": {
          type: "string",
          default: String(DEFAULT_LEDGER_STALENESS_DAYS),
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    }).values;
    if (args.help) {
      console.log(
        "Usage: check-version-freshness.mjs [-h] [--strict] [--today YYYY-MM-DD] [--version-staleness-days N] [--ledger-staleness-days N]\nOffline freshness checker for KernelWiki. Default mode is advisory; --strict exits 1 on warnings.",
      );
      return 0;
    }
    for (const key of ["version-staleness-days", "ledger-staleness-days"]) {
      if (!/^[+-]?\d+$/.test(args[key]) || !Number.isSafeInteger(Number(args[key]))) {
        throw new TypeError(`--${key}: invalid int value: ${repr(args[key])}`);
      }
    }
    versionDays = Number(args["version-staleness-days"]);
    ledgerDays = Number(args["ledger-staleness-days"]);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  try {
    const now = new Date();
    today = args.today
      ? parseIso(args.today)
      : parseIso(
          `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        );
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 1;
  }
  const toolVersions = loadJson(path.join(DATA_DIR, "tool-versions.json")) || {};
  const receipt = loadJson(path.join(DATA_DIR, "tool-release-receipt.json"));
  const claims = loadJson(path.join(DATA_DIR, "version-claims.json")) || {};
  const cutoffData = loadJson(path.join(DATA_DIR, "refresh-cutoff.json"));
  let cutoff = null;
  if (cutoffData && Object.hasOwn(cutoffData, "cutoff_date")) {
    try {
      cutoff = parseIso(cutoffData.cutoff_date);
    } catch (e) {
      if (!(e instanceof RangeError)) {
        throw e;
      }
      console.error(
        `WARN: data/refresh-cutoff.json::cutoff_date is unparseable: ${repr(cutoffData.cutoff_date)}`,
      );
    }
  }
  const findings = [
    ...checkToolVersions(toolVersions, today, versionDays),
    ...checkReleaseReceipt(toolVersions, receipt),
    ...checkVersionClaims(claims, toolVersions, today, versionDays),
    ...checkLedgerFreshness(today, ledgerDays, cutoff),
  ];
  const warns = findings.filter(([severity]) => severity === "warn").map(([, message]) => message);
  const infos = findings.filter(([severity]) => severity === "info").map(([, message]) => message);
  console.log(
    `check-version-freshness.mjs — today=${iso(today)}, version-staleness=${versionDays}d, ledger-staleness=${ledgerDays}d`,
  );
  console.log(`  ${warns.length} warnings, ${infos.length} info messages`);
  for (const message of warns) {
    console.log(`  WARN: ${message}`);
  }
  for (const message of infos) {
    console.log(`  INFO: ${message}`);
  }
  if (args.strict && warns.length) {
    console.error(`\n--strict: ${warns.length} warning(s) -> exit 1`);
    return 1;
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
