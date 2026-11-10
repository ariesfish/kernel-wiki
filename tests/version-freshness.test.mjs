import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as F from "../scripts/check-version-freshness.mjs";
import { stringify } from "../scripts/lib/yaml.mjs";
import { ROOT, import_in_root, put, run, temp_root } from "./helpers/maintenance-fixtures.mjs";

const today = F.parse_iso("2026-08-18");
const warnings = (findings) => [...findings].filter(([severity]) => severity === "warn").map(([, message]) => message);
function findings(checked_at = "2026-08-18", released_at = "2026-06-18") {
  const tool = { tool: "triton", releases: [{ name: "3.7.1", released_at }] };
  if (checked_at !== null) tool.upstream_checked_at = checked_at;
  return [...F.check_tool_versions({ tools: [tool] }, today, 180)];
}
function fixtures() {
  return [
    { tools: [{ tool: "triton", upstream_checked_at: "2026-08-18", releases: [{ name: "3.7.1", released_at: "2026-06-18" }] }] },
    { tools: { triton: { upstream_checked_at: "2026-08-18", releases: [["3.7.1", "2026-06-18"]] } } },
  ];
}

test("recent upstream receipt is clean", () => assert.deepEqual(warnings(findings()), []));
test("missing upstream receipt warns", () => assert.ok(warnings(findings(null)).some((m) => m.includes("missing upstream_checked_at"))));
test("stale upstream receipt warns", () => assert.ok(warnings(findings("2025-12-01")).some((m) => m.includes("upstream_checked_at") && m.includes("ago"))));
test("release cannot postdate upstream receipt", () => assert.ok(warnings(findings("2026-05-01", "2026-06-18")).some((m) => m.includes("newer than upstream_checked_at"))));
test("exact registry receipt match is clean", () => assert.deepEqual(warnings(F.check_release_receipt(...fixtures())), []));
test("missing receipted release warns", () => {
  const [registry, receipt] = fixtures();
  registry.tools[0].releases = [];
  assert.ok(warnings(F.check_release_receipt(registry, receipt)).some((m) => m.includes("missing receipted releases")));
});
test("unreceipted registry release warns", () => {
  const [registry, receipt] = fixtures();
  registry.tools[0].releases.push({ name: "3.8.0", released_at: "2026-08-19" });
  assert.ok(warnings(F.check_release_receipt(registry, receipt)).some((m) => m.includes("unreceipted releases")));
});
test("checked_at mismatch warns", () => {
  const [registry, receipt] = fixtures();
  registry.tools[0].upstream_checked_at = "2026-08-19";
  assert.ok(warnings(F.check_release_receipt(registry, receipt)).some((m) => m.includes("upstream_checked_at mismatch")));
});

test("date parsing accepts calendar, compact, week, and Date values, rejecting impossible dates", () => {
  for (const value of ["2026-08-18", "20260818", "2026-W34-2", "2026W342", new Date("2026-08-18T23:59:00Z")]) assert.equal(F.parse_iso(value).toISOString(), "2026-08-18T00:00:00.000Z");
  assert.equal(F.parse_iso("2020-W53-7").toISOString(), "2021-01-03T00:00:00.000Z");
  for (const value of ["2026-02-30", "2025-02-29", "2026-13-01", "2025-W53-1", "0000-01-01", "2026-08-18T00:00:00Z", "nonsense", null, new Date(NaN)]) assert.throws(() => F.parse_iso(value), RangeError, String(value));
});

test("staleness is strictly older than threshold, and old releases are info only", () => {
  const threshold = new Date(+today - 180 * 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(warnings(findings(threshold, threshold)), []);
  assert.deepEqual(findings("2026-08-18", "2025-01-01").map(([s]) => s), ["info"]);
  assert.ok(warnings(findings("not-a-date")).some((m) => m.includes("unparseable upstream_checked_at")));
  for (const date of [null, "needs-verification", "2026-02-30"]) assert.equal(warnings(findings("2026-08-18", date)).length, 1);
});

test("receipt rejects invalid shapes, absent tools, bad dates, and unregistered tools", () => {
  const [registry, receipt] = fixtures();
  for (const value of [null, [], {}, { tools: [] }]) assert.equal(warnings(F.check_release_receipt(registry, value)).length, 1);
  assert.match(warnings(F.check_release_receipt(registry, { tools: {} }))[0], /missing receipt for triton/);
  receipt.tools.triton.releases = [["only-name"]];
  assert.match(warnings(F.check_release_receipt(registry, receipt))[0], /must be \[name, released_at\]/);
  receipt.tools.triton.releases = [["3.7.1", "2026-02-30"]];
  assert.match(warnings(F.check_release_receipt(registry, receipt))[0], /Invalid isoformat string/);
  receipt.tools.triton.releases = [];
  receipt.tools.extra = {};
  assert.ok(warnings(F.check_release_receipt(registry, receipt)).some((m) => m.includes("receipts without registry tools ['extra']")));
});

test("release receipt compares sets without order or duplicate sensitivity", () => {
  const [registry, receipt] = fixtures();
  receipt.tools.triton.releases.push(receipt.tools.triton.releases[0]);
  registry.tools[0].releases.push(registry.tools[0].releases[0]);
  assert.deepEqual(warnings(F.check_release_receipt(registry, receipt)), []);
});

test("version claims require a verification date and a known release", () => {
  const [registry] = fixtures();
  const claims = { claims: [
    { id: "missing" }, { id: "invalid", last_verified_at: "bad" },
    { id: "stale", last_verified_at: "2025-01-01", last_verified_release: "unknown" },
    { id: "valid", last_verified_at: "2026-08-18", last_verified_release: "3.7.1" },
  ] };
  const messages = warnings(F.check_version_claims(claims, registry, today, 180));
  assert.equal(messages.length, 4);
  for (const text of ["missing last_verified_at", "unparseable", "ago", "not in data/tool-versions.yaml"]) assert.ok(messages.some((m) => m.includes(text)));
  assert.deepEqual([...F.check_version_claims(null, registry, today, 180)], []);
});

test("ledger cutoff disagreement remains info and supersession is limited to the first three lines", async (t) => {
  const root = temp_root(t);
  put(root, "candidates/a.yaml", "searched_at: 2025-01-01\n");
  put(root, "candidates/b.yaml", "{}\n");
  put(root, "candidates/c.yaml", "searched_at: bad\n");
  put(root, "candidates/d.yaml", "[]\n");
  put(root, "plan-phase1.md", "# Plan\n\n> sUpErSeDeD by phase4\n");
  put(root, "plan-phase2.md", "# Plan\n\nbody\n> Superseded by phase4\n");
  put(root, "plan-phase4.md", "> Superseded by future\n");
  const f = await import_in_root("check-version-freshness.mjs", root);
  assert.equal(warnings(f.check_ledger_freshness(today, 30, null)).length, 3);
  const cutoff_findings = [...f.check_ledger_freshness(today, 30, today)];
  assert.equal(warnings(cutoff_findings).length, 2);
  assert.ok(cutoff_findings.some(([s, m]) => s === "info" && m.includes("disagrees with refresh-cutoff")));
  assert.deepEqual([...f.check_supersession(today)].map(([, m]) => m.split(":")[0]), ["plan-phase2.md", "plan-phase4.md"]);
  assert.equal(f.is_superseded(path.join(root, "missing.md")), false);
  assert.equal(f.load_yaml(path.join(root, "missing.yaml")), null);
});

test("freshness CLI is advisory by default, strict on warnings, and validates every flag", (t) => {
  const root = temp_root(t);
  put(root, "data/tool-versions.yaml", stringify(fixtures()[0]));
  let result = run("check-version-freshness.mjs", ["--today", "2026-08-18"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /missing or invalid receipt/);
  assert.equal(run("check-version-freshness.mjs", ["--today", "2026-08-18", "--strict"], root).status, 1);
  put(root, "data/tool-release-receipt.yaml", stringify(fixtures()[1]));
  result = run("check-version-freshness.mjs", ["--today", "2026-08-18", "--strict", "--version-staleness-days", "1", "--ledger-staleness-days", "2"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /version-staleness=1d, ledger-staleness=2d/);
  assert.equal(run("check-version-freshness.mjs", ["--today", "2026-08-18", "--version-staleness-days", "-1"], root).status, 0);
  for (const args of [["--unknown"], ["--version-staleness-days", "1.5"], ["--ledger-staleness-days", "bad"]]) assert.equal(run("check-version-freshness.mjs", args, root).status, 2);
  assert.equal(run("check-version-freshness.mjs", ["--today", "2026-02-30"], root).status, 1);
  assert.equal(run("check-version-freshness.mjs", ["--help"], root).status, 0);
});

test("freshness remains offline with network and subprocess APIs trapped and an empty PATH", (t) => {
  const root = temp_root(t);
  const source = fs.readFileSync(path.join(ROOT, "scripts/check-version-freshness.mjs"), "utf8");
  const imports = [...source.matchAll(/^import .*? from ["']([^"']+)["'];/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:fs", "node:os", "node:path", "node:url", "node:util", "./lib/yaml.mjs"]);
  assert.doesNotMatch(source, /\b(?:fetch|require|import)\s*\(|(?<![.\w])(?:exec|execFile|spawn|spawnSync|execSync|execFileSync)\s*\(/);
  const guard = put(root, "offline-guard.mjs", `
import cp from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('OFFLINE VIOLATION'); };
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = deny;
for (const module of [http, https]) for (const key of ['get', 'request']) module[key] = deny;
net.connect = net.createConnection = tls.connect = http2.connect = dgram.createSocket = deny;
net.Socket.prototype.connect = deny;
dns.lookup = dns.resolve = dns.promises.lookup = dns.promises.resolve = deny;
globalThis.fetch = globalThis.WebSocket = deny;
syncBuiltinESMExports();
`);
  const result = run("check-version-freshness.mjs", ["--today", "2026-08-18", "--strict"], ROOT, { execArgv: [], env: { PATH: "", NODE_OPTIONS: `--import=${guard}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 warnings, 7 info messages/);
  assert.doesNotMatch(result.stderr, /OFFLINE VIOLATION/);
});
