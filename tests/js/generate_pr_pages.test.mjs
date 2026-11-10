import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate_page, fetch_pr_files, process_ledger, load_skip_audit, write_skip_audit, record_skip } from "../../scripts/generate-pr-pages.mjs";
import { body_contract_errors } from "../../scripts/pr_policy.mjs";
import { parse, stringify } from "../../scripts/_yaml.mjs";

const cases = JSON.parse(fs.readFileSync(new URL("../fixtures/python-generation-baseline.json", import.meta.url), "utf8"));
for (const fixture of cases) test(`PR generation preserves Python metadata and body: ${fixture.name}`, () => {
  const result = generate_page(...structuredClone(fixture.args));
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(result);
  assert.ok(match);
  const fm = parse(match[1]);
  assert.deepEqual(fm, fixture.frontmatter);
  assert.equal(match[2], fixture.body);
  assert.deepEqual(body_contract_errors(fm, match[2]), []);
});

test("PR files are paginated and a capped listing never appears complete", () => {
  let calls = 0;
  const rows = fetch_pr_files("example/project", 7, () => ++calls === 1 ? Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` })) : [{ filename: "last" }]);
  assert.equal(calls, 2); assert.equal(rows.length, 101);
  assert.throws(() => fetch_pr_files("example/project", 7, () => Array(100).fill({ filename: "f" })), /3000 changed-file API limit/);
  assert.deepEqual(fetch_pr_files("example/project", 7, () => null), []);
});

test("merged PRs require a merge SHA and authoritative totals cannot shrink", () => {
  const args = structuredClone(cases[0].args);
  args[1].merged = true; delete args[1].merge_commit_sha;
  assert.throws(() => generate_page(...args), /no merge_commit_sha/);
  args[1].merged = false; args[1].changed_files = -1;
  assert.throws(() => generate_page(...args), /file records were supplied/);
});

test("ledger generation skips existing pages, records failures and writes only retained PRs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-generation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "sources/prs/project"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "PR-1.md"), "existing evidence\n");
  const ledger = path.join(root, "ledger.yaml");
  fs.writeFileSync(ledger, stringify({ repo: "example/project", prs: [1, 2, 3, 4, 5].map((number) => ({ number, decision: number === 5 ? "exclude" : "include" })) }));
  const audit = new Map(); const fetched = [];
  const count = process_ledger(ledger, null, "2026-08-18", audit, { root,
    fetch_pr: (_repo, number) => { fetched.push(number); return number === 2 ? null : { ...cases[0].args[1], number }; },
    fetch_pr_files: (_repo, number) => number === 3 ? [{ filename: "python/layer.py", patch: "+def configure():\n+    pass" }] : cases[0].args[2],
  });
  assert.equal(count, 1); assert.deepEqual(fetched, [2, 3, 4]);
  assert.equal(fs.readFileSync(path.join(dir, "PR-1.md"), "utf8"), "existing evidence\n");
  assert.ok(fs.existsSync(path.join(dir, "PR-4.md"))); assert.ok(!fs.existsSync(path.join(dir, "PR-3.md")));
  assert.equal(audit.get("example/project#2").stage, "pre-fetch");
  assert.equal(audit.get("example/project#3").stage, "is-kernel-related");
  const auditFile = path.join(root, "audit.yaml");
  record_skip(audit, "abc/project", 9, "pre-fetch", "failed", "2026-08-18");
  write_skip_audit(audit, auditFile); const first = fs.readFileSync(auditFile, "utf8");
  write_skip_audit(load_skip_audit(auditFile), auditFile); assert.equal(fs.readFileSync(auditFile, "utf8"), first);
  assert.equal(parse(first).rows[0].repo, "abc/project");
});
