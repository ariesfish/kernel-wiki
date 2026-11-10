import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifySearchHit,
  fetchPrEvidence,
  ghSearchPrs,
  isoDate,
  updateLedger,
  writeSearchResults,
} from "../scripts/refresh-candidate-ledger.mjs";
import { parse, parseMaintenance, stringify } from "../scripts/lib/yaml.mjs";
const kernel = [
  {
    filename: "csrc/kernel.cu",
    patch: "+__global__ void kernel() {}",
  },
];
const fetcher = () => [
  {
    title: "Add kernel",
    body: "",
  },
  kernel,
];
test("refresh classifies authoritative positive kernel evidence", () => {
  const [decision, reason, paths] = classifySearchHit(
    "example/project",
    {
      number: 1,
      title: "stale",
    },
    fetcher,
  );
  assert.equal(decision, "include");
  assert.match(reason, /^retain:/);
  assert.deepEqual(paths, ["csrc/kernel.cu"]);
});
test("refresh excludes host Python even under kernelish paths", () => {
  const [decision, reason] = classifySearchHit(
    "example/project",
    {
      number: 2,
      title: "stale",
    },
    () => [
      {
        title: "Update fused MoE placement",
        body: "host configuration",
      },
      [
        {
          filename: "python/fused_moe/layer.py",
          patch: "+def configure():\n+    pass",
        },
      ],
    ],
  );
  assert.equal(decision, "exclude");
  assert.match(reason, /^remove:/);
});
test("unavailable evidence remains a defer decision", () => {
  assert.deepEqual(
    classifySearchHit(
      "example/project",
      {
        number: 3,
      },
      () => null,
    ),
    ["defer", "authoritative PR evidence unavailable; needs-triage", []],
  );
});
test("evidence fetch paginates and preserves failure as unavailable", () => {
  const calls = [];
  const evidence = fetchPrEvidence("example/project", 1, (args) => {
    calls.push(args[1]);
    if (calls.length === 1) {
      return {
        title: "PR",
      };
    }
    return calls.length === 2 ? Array(100).fill(kernel[0]) : kernel;
  });
  assert.equal(evidence[1].length, 101);
  assert.match(calls[2], /page=2$/);
  assert.equal(
    fetchPrEvidence("example/project", 1, () => {
      throw new Error("network down");
    }),
    null,
  );
  assert.equal(
    fetchPrEvidence("example/project", 1, () => ({})),
    null,
  );
});
test("search unions per-keyword results and respects the cutoff", async () => {
  let calls = 0;
  const rows = await ghSearchPrs("example/project", ["a", "b"], "2026-08-18", 30, 0, () =>
    ++calls === 1
      ? [
          {
            number: 2,
            title: "first",
            closedAt: "2026-08-17T00:00:00Z",
          },
          {
            number: 9,
            closedAt: "2026-08-19T00:00:00Z",
          },
        ]
      : [
          {
            number: 2,
            title: "duplicate",
            closedAt: "2026-08-17T00:00:00Z",
          },
          {
            number: 1,
            title: "new",
            closedAt: "2026-08-18T00:00:00Z",
          },
        ],
  );
  assert.deepEqual(
    rows.map((row) => row.number),
    [2, 1],
  );
  assert.equal(rows[0].title, "first");
});
test("invalid dates fail instead of rolling into another month", () => {
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-8-1", "0000-01-01"]) {
    assert.throws(() => isoDate(date), /Invalid ISO date/);
  }
  assert.equal(isoDate("2024-02-29"), "2024-02-29");
});
test("refresh without new rows preserves existing numeric and timestamp metadata", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-refresh-types-"));
  t.after(() =>
    fs.rmSync(dir, {
      recursive: true,
      force: true,
    }),
  );
  const file = path.join(dir, "ledger.yaml");
  fs.writeFileSync(
    file,
    "repo: example/project\nprs:\n- number: 1\n  decision: defer\n  score: 0.0000001\n  receipt_id: 9007199254740993\n  timestamp: 2026-08-18T12:34:56.123456+02:00\n  midnight: 2026-08-18T00:00:00Z\n",
  );
  assert.equal(updateLedger(file, "2026-08-18", []), 0);
  const once = fs.readFileSync(file, "utf8");
  const row = parseMaintenance(once).prs[0];
  assert.equal(row.score, 1e-7);
  assert.equal(typeof row.score, "number");
  assert.equal(row.receipt_id, 9007199254740993n);
  assert.match(once, /timestamp: 2026-08-18T12:34:56\.123456\+02:00/);
  assert.match(once, /midnight: 2026-08-18T00:00:00Z/);
  assert.equal(updateLedger(file, "2026-08-18", []), 0);
  assert.equal(fs.readFileSync(file, "utf8"), once);
});
test("refresh preserves existing triage and emits deterministic ledgers/results", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-refresh-"));
  t.after(() =>
    fs.rmSync(dir, {
      recursive: true,
      force: true,
    }),
  );
  const file = path.join(dir, "ledger.yaml");
  const existing = {
    number: 1,
    decision: "defer",
    reason: "curator decision",
  };
  fs.writeFileSync(
    file,
    stringify({
      repo: "example/project",
      prs: [existing],
    }),
  );
  const hits = [
    {
      number: 1,
      title: "changed",
    },
    {
      number: 2,
      title: "new",
      closedAt: "2026-08-17",
    },
  ];
  assert.equal(updateLedger(file, "2026-08-18", hits, null, fetcher), 1);
  const data = parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(data.prs[0], existing);
  assert.equal(data.prs[1].decision, "include");
  assert.equal(data.total_candidates, 2);
  assert.equal(data.included, 1);
  assert.equal(data.deferred, 1);
  const first = fs.readFileSync(file, "utf8");
  assert.equal(updateLedger(file, "2026-08-18", hits, null, fetcher), 0);
  assert.equal(fs.readFileSync(file, "utf8"), first);
  const output = path.join(dir, "results.yaml");
  const repos = {
    z: [
      {
        number: 3,
        closedAt: "2026-08-17",
      },
      {
        number: 2,
        closedAt: "2026-08-16",
      },
    ],
    a: [],
  };
  writeSearchResults("2026-08-18", repos, output);
  const once = fs.readFileSync(output, "utf8");
  writeSearchResults("2026-08-18", repos, output);
  assert.equal(fs.readFileSync(output, "utf8"), once);
  assert.deepEqual(
    parse(once).repos.map((row) => row.repo_slug),
    ["a", "z"],
  );
  assert.deepEqual(parse(once).repos[1].pr_numbers_seen, [2, 3]);
});
