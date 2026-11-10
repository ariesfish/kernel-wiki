import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchPrFiles,
  generatePage,
  loadSkipAudit,
  processLedger,
  recordSkip,
  writeSkipAudit,
} from "../scripts/generate-pr-pages.mjs";
import { bodyContractErrors } from "../scripts/lib/pr-policy.mjs";
import { parseJson, stringifyJson as stringify } from "../scripts/lib/json.mjs";
import { parse } from "../scripts/lib/yaml.mjs";
const cases = JSON.parse(
  fs.readFileSync(new URL("./fixtures/pr-page-cases.json", import.meta.url), "utf8"),
);
assert.ok(cases.length >= 8, "The page behavior bank must retain at least eight cases");
for (const fixture of cases) {
  test(`PR generation preserves captured metadata and body: ${fixture.name}`, () => {
    const result = generatePage(...structuredClone(fixture.args));
    const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(result);
    assert.ok(match);
    const fm = parse(match[1]);
    assert.deepEqual(fm, fixture.frontmatter);
    assert.equal(match[2], fixture.body);
    assert.deepEqual(bodyContractErrors(fm, match[2]), []);
  });
}
test("PR files are paginated and a capped listing never appears complete", () => {
  let calls = 0;
  const rows = fetchPrFiles("example/project", 7, () =>
    ++calls === 1
      ? Array.from(
          {
            length: 100,
          },
          (_, i) => ({
            filename: `f${i}`,
          }),
        )
      : [
          {
            filename: "last",
          },
        ],
  );
  assert.equal(calls, 2);
  assert.equal(rows.length, 101);
  assert.throws(
    () =>
      fetchPrFiles("example/project", 7, () =>
        Array(100).fill({
          filename: "f",
        }),
      ),
    /3000 changed-file API limit/,
  );
  assert.deepEqual(
    fetchPrFiles("example/project", 7, () => null),
    [],
  );
});
test("merged PRs require a merge SHA and authoritative totals cannot shrink", () => {
  const args = structuredClone(cases[0].args);
  args[1].merged = true;
  delete args[1].merge_commit_sha;
  assert.throws(() => generatePage(...args), /no merge_commit_sha/);
  args[1].merged = false;
  args[1].changed_files = -1;
  assert.throws(() => generatePage(...args), /file records were supplied/);
});
test("ledger generation skips existing pages, records failures and writes only retained PRs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-generation-"));
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
    }),
  );
  const dir = path.join(root, "sources/prs/project");
  fs.mkdirSync(dir, {
    recursive: true,
  });
  fs.writeFileSync(path.join(dir, "PR-1.md"), "existing evidence\n");
  const ledger = path.join(root, "ledger.json");
  fs.writeFileSync(
    ledger,
    stringify({
      repo: "example/project",
      prs: [1, 2, 3, 4, 5].map((number) => ({
        number,
        decision: number === 5 ? "exclude" : "include",
      })),
    }),
  );
  const audit = new Map();
  const fetched = [];
  const count = processLedger(ledger, null, "2026-08-18", audit, {
    root,
    fetchPr: (repo, number) => {
      fetched.push(number);
      return number === 2
        ? null
        : {
            ...cases[0].args[1],
            number,
          };
    },
    fetchPrFiles: (repo, number) =>
      number === 3
        ? [
            {
              filename: "python/layer.py",
              patch: "+def configure():\n+    pass",
            },
          ]
        : cases[0].args[2],
  });
  assert.equal(count, 1);
  assert.deepEqual(fetched, [2, 3, 4]);
  assert.equal(fs.readFileSync(path.join(dir, "PR-1.md"), "utf8"), "existing evidence\n");
  assert.ok(fs.existsSync(path.join(dir, "PR-4.md")));
  assert.ok(!fs.existsSync(path.join(dir, "PR-3.md")));
  assert.equal(audit.get("example/project#2").stage, "pre-fetch");
  assert.equal(audit.get("example/project#3").stage, "is-kernel-related");
  const auditFile = path.join(root, "audit.json");
  recordSkip(audit, "abc/project", 9, "pre-fetch", "failed", "2026-08-18");
  recordSkip(audit, "abc/project", 9007199254740993n, "pre-fetch", "failed", "2026-08-18");
  writeSkipAudit(audit, auditFile);
  const first = fs.readFileSync(auditFile, "utf8");
  writeSkipAudit(loadSkipAudit(auditFile), auditFile);
  assert.equal(fs.readFileSync(auditFile, "utf8"), first);
  assert.equal(parseJson(first).rows[0].repo, "abc/project");
  assert.deepEqual(
    parseJson(first)
      .rows.filter((row) => row.repo === "abc/project")
      .map((row) => row.pr_number),
    [9, 9007199254740993n],
  );
});
