import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "../scripts/lib/yaml.mjs";
import { computeManifests, dumpSorted } from "../scripts/compute-core-prs.mjs";
import { EnvError, main } from "../scripts/verify-core-prs.mjs";
import { fixture, page, pr, put, quiet } from "./helpers/asset-fixtures.mjs";
function corpus(t) {
  const root = fixture(t);
  pr(root, 1);
  pr(root, 2);
  page(root, "wiki/a.md", {
    sources: ["pr-demo-1", "pr-demo-2"],
  });
  for (const [name, bytes] of Object.entries(computeManifests(root))) {
    put(root, `data/${name}`, bytes);
  }
  return root;
}
test("read-only manifest verification succeeds without changing bytes", async (t) => {
  const root = corpus(t),
    before = computeManifests(root);
  assert.equal(await main([], quiet(root)), 0);
  for (const [name, bytes] of Object.entries(before)) {
    assert.deepEqual(readFileSync(path.join(root, "data", name)), bytes);
  }
});
test("missing core input is environment failure; missing companion and drift are content failures", async (t) => {
  const root = corpus(t);
  unlinkSync(path.join(root, "data/triton-universe.yaml"));
  assert.equal(await main([], quiet(root)), 1);
  put(root, "data/triton-universe.yaml", "drift\n");
  assert.equal(await main([], quiet(root)), 1);
  unlinkSync(path.join(root, "data/core-prs.yaml"));
  assert.equal(await main([], quiet(root)), 2);
});
test("generator failure is inconclusive and incomplete generator output is content failure", async (t) => {
  const root = corpus(t);
  assert.equal(
    await main(
      [],
      quiet(root, {
        computeManifests() {
          throw new Error("missing policy");
        },
      }),
    ),
    2,
  );
  assert.equal(
    await main(
      [],
      quiet(root, {
        computeManifests: () => ({}),
      }),
    ),
    1,
  );
});
test("internal count and checksum are checked even when committed bytes match regeneration", async (t) => {
  const root = corpus(t),
    fresh = computeManifests(root),
    initial = parse(fresh["core-prs.yaml"].toString());
  for (const change of [
    {
      total_captured: 99,
    },
    {
      checksum_sha256: "0".repeat(64),
    },
  ]) {
    const core = Buffer.from(
      dumpSorted({
        ...initial,
        ...change,
      }),
    );
    put(root, "data/core-prs.yaml", core);
    assert.equal(
      await main(
        [],
        quiet(root, {
          computeManifests: () => ({
            ...fresh,
            "core-prs.yaml": core,
          }),
        }),
      ),
      1,
    );
  }
});
test("strict verification accepts merge prefixes, rejects head-only matches and unmerged pulls", async (t) => {
  const root = corpus(t);
  const run = (pull) =>
    main(
      ["--strict"],
      quiet(root, {
        runGh: () => JSON.stringify(pull),
      }),
    );
  assert.equal(
    await run({
      merged: true,
      merge_commit_sha: "abcdef1234567890",
      head: {
        sha: "other",
      },
    }),
    0,
  );
  assert.equal(
    await run({
      merged: true,
      merge_commit_sha: "1111111111111111",
      head: {
        sha: "abcdef1234567890",
      },
    }),
    1,
  );
  assert.equal(
    await run({
      merged: false,
      state: "closed",
    }),
    1,
  );
});
test("strict environment failures take precedence over content findings", async (t) => {
  const root = corpus(t);
  let calls = 0;
  assert.equal(
    await main(
      ["--strict"],
      quiet(root, {
        runGh() {
          if (++calls === 1) {
            return '{"merged":false}';
          }
          throw new EnvError("network is unreachable");
        },
      }),
    ),
    2,
  );
  assert.equal(calls, 2);
  assert.equal(
    await main(
      ["--strict"],
      quiet(root, {
        runGh() {
          throw new Error("HTTP 404: Not Found");
        },
      }),
    ),
    1,
  );
});
test("strict mode flags missing source pages and incomplete source metadata", async (t) => {
  const root = corpus(t);
  unlinkSync(path.join(root, "sources/prs/demo/PR-1.md"));
  pr(root, 2, {
    merge_sha: null,
  });
  const fresh = {
    "core-prs.yaml": readFileSync(path.join(root, "data/core-prs.yaml")),
    "cute-dsl-universe.yaml": readFileSync(path.join(root, "data/cute-dsl-universe.yaml")),
    "triton-universe.yaml": readFileSync(path.join(root, "data/triton-universe.yaml")),
  };
  assert.equal(
    await main(
      ["--strict"],
      quiet(root, {
        computeManifests: () => fresh,
        runGh() {
          throw new Error("must not call");
        },
      }),
    ),
    1,
  );
});
test("unknown CLI flags are invocation errors", async (t) => {
  assert.equal(await main(["--unknown"], quiet(corpus(t))), 2);
});
