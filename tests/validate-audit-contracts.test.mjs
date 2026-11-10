import { stringifyJson } from "../scripts/lib/json.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { stringify } from "../scripts/lib/yaml.mjs";
import * as v from "../scripts/validate.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const corpusData = (name) => v.loadDataFile(path.join(ROOT, name));
function fixture(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "wiki-audit-")),
    previous = v.REPO_ROOT;
  const write = (name, data) => {
    const filename = path.join(root, name);
    mkdirSync(path.dirname(filename), {
      recursive: true,
    });
    writeFileSync(
      filename,
      typeof data === "string" || Buffer.isBuffer(data)
        ? data
        : filename.endsWith(".json")
          ? stringifyJson(data)
          : stringify(data),
    );
    return filename;
  };
  v.configureRoot(root);
  try {
    return callback({
      root,
      write,
      page: (name, fm, body = "") => write(name, `---\n${stringify(fm)}---\n${body}`),
    });
  } finally {
    v.configureRoot(previous);
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
const has = (errors, phrase) =>
  assert.ok(
    errors.some((error) => error.includes(phrase)),
    errors.join("\n"),
  );
test("implicit YAML values retain PyYAML SHA, boolean, octal and exponent contracts", () =>
  fixture(({ write }) => {
    const filename = write(
      "values.yaml",
      "sha: 0e026982\ny: y\nn: n\nyes: yes\nno: no\noctal: 012\nnot_octal: 08\nexponent: 1e3\nfloat: 1.0e+3\nbase60: 1:20\nnot_base60: 0:20\n",
    );
    assert.deepEqual(v.loadDataFile(filename), {
      sha: "0e026982",
      y: "y",
      n: "n",
      true: true,
      false: false,
      octal: 10,
      not_octal: "08",
      exponent: "1e3",
      float: 1000,
      base60: 80,
      not_base60: "0:20",
    });
  }));
test("aliases reject collisions, product drift and family collapse", () => {
  assert.deepEqual(
    v.validateAliasContract({
      sm100: ["B200"],
      blackwell: ["Blackwell"],
    }),
    [],
  );
  has(
    v.validateAliasContract({
      sm100: ["B200"],
      sm120: ["b200"],
    }),
    "maps to both",
  );
  has(
    v.validateAliasContract({
      sm120: ["B200"],
    }),
    "pr_policy requires",
  );
  has(
    v.validateAliasContract({
      sm100: ["blackwell"],
    }),
    "resolves to exact term",
  );
  has(v.validateAliasContract([]), "top level must be a mapping");
  has(
    v.validateAliasContract({
      x: "bad",
    }),
    "aliases must be a list",
  );
  has(
    v.validateAliasContract({
      x: [false],
    }),
    "aliases must be non-empty strings",
  );
  fixture(({ write }) => {
    write("data/aliases.json", {
      "": ["empty-canonical-key"],
    });
    has(v.validateAliasContract(), "canonical terms must be non-empty strings");
  });
});
test("file validation rejects malformed frontmatter and unknown page types", () =>
  fixture(({ write, page }) => {
    const check = (filename) => v.validateFile(filename, {}, {}, new Set(), new Set());
    has(check(write("wiki/bad.md", "# Missing")), "missing YAML frontmatter");
    has(check(write("wiki/bad.md", "---\n[one, two]\n---\n")), "mapping, got list");
    has(check(write("wiki/bad.md", "---\nx: [\n---\n")), "YAML parse error");
    has(
      check(
        page("other/page.md", {
          id: "x",
        }),
      ),
      "unknown page type",
    );
    has(
      check(
        page("wiki/techniques/page.md", {
          id: "x",
        }),
      ),
      "no schema defined for type 'wiki-technique'",
    );
  }));
test("PR evidence, scope and upstream body contracts remain enforced together", () => {
  const original = path.join(ROOT, "sources/prs/cutlass/PR-2472.md");
  const base = v.extractFrontmatter(original),
    body = v.readBody(original);
  const schemas = corpusData("data/schemas.json"),
    tags = corpusData("data/tags.json");
  fixture(({ root, page }) => {
    mkdirSync(path.join(root, base.artifact_dir), {
      recursive: true,
    });
    const check = (fm) =>
      v.validateFile(
        page("sources/prs/cutlass/PR-2472.md", fm, body),
        schemas,
        tags,
        new Set(),
        v.BASE_CODE_LANGS,
      );
    assert.deepEqual(check(base), []);
    const mutations = [
      [
        {
          architecture_disposition: "other",
        },
        "architecture_disposition must be",
      ],
      [
        {
          architecture_evidence: [],
        },
        "architecture_evidence must be a non-empty list",
      ],
      [
        {
          architecture_evidence: ["bad"],
        },
        "architecture_evidence[0] must be a mapping",
      ],
      [
        {
          architecture_evidence: [{}],
        },
        ".architecture must be a non-empty string",
      ],
      [
        {
          architecture_evidence: [
            {
              architecture: "sm100",
              basis: "documented-product-mapping",
              locator: "x",
              evidence: "B200",
            },
          ],
        },
        "HTTPS mapping_source",
      ],
      [
        {
          architecture_disposition: "unknown",
        },
        "unknown disposition requires architectures: []",
      ],
      [
        {
          architecture_disposition: "family",
        },
        "family disposition requires only recognized family values",
      ],
      [
        {
          architecture_disposition: "exact",
          architectures: ["blackwell"],
        },
        "exact disposition requires",
      ],
      [
        {
          architecture_disposition: "mixed",
        },
        "mixed disposition requires family and exact values",
      ],
      [
        {
          scope_disposition: "removed",
        },
        "scope_disposition: retained",
      ],
      [
        {
          scope_evidence: null,
        },
        "scope_evidence must be a mapping",
      ],
      [
        {
          scope_evidence: {
            rule: "bad",
            paths: [],
          },
        },
        "unsupported retained scope rule",
      ],
      [
        {
          scope_evidence: {
            rule: "cuda-cute-ptx-device-source",
            paths: ["absent.py"],
          },
        },
        "CUDA/CuTe/PTX scope rule cites a non-device-source path",
      ],
      [
        {
          scope_evidence: {
            rule: "python-dsl-device-kernel",
            paths: ["absent.cu"],
          },
        },
        "Python DSL scope rule cites a non-Python path",
      ],
      [
        {
          inclusion_reason: "generic",
        },
        "inclusion_reason must name",
      ],
      [
        {
          title: "DeepEP update",
        },
        "hard-excluded EPLB/DeepEP/DualPipe",
      ],
      [
        {
          upstream_body_locator: "http://example.org",
        },
        "HTTPS locator",
      ],
      [
        {
          upstream_body_sha256: "invalid",
        },
        "SHA-256",
      ],
    ];
    for (const [mutation, phrase] of mutations) {
      has(
        check({
          ...base,
          ...mutation,
        }),
        phrase,
      );
    }
  });
});
test("bundle hashes, manifest drift, size caps and resolved containment are enforced", () =>
  fixture(({ root, write }) => {
    const bundle = "artifacts/prs/example/PR-1",
      directory = path.join(root, bundle);
    const file = write(`${bundle}/kernel.cu`, "__global__ void kernel() {}\n");
    const entry = {
      local_path: "kernel.cu",
      role: "upstream-file",
      mode: "verbatim",
      sha256: v.sha256OfFile(file),
    };
    const prov = {
      origin_url: "https://example.org",
      upstream_repo: "example/project",
      upstream_sha: "a".repeat(40),
      license: "MIT",
      retrieved_at: "2026-01-01",
      asset_mode: "verbatim",
      files: [entry],
    };
    const check = (metadata) => {
      write(`${bundle}/PROVENANCE.yaml`, metadata);
      return v.validateBundle(directory, new Set());
    };
    assert.deepEqual(check(prov), []);
    has(
      check({
        ...prov,
        files: [
          {
            ...entry,
            sha256: "b".repeat(64),
          },
        ],
      }),
      "sha256 mismatch",
    );
    has(
      check({
        ...prov,
        files: [],
      }),
      "manifest drift",
    );
    has(
      check({
        ...prov,
        asset_mode: "derived",
        derived_from: ["unknown"],
      }),
      "only allowed under artifacts/kernels/*/variants",
    );
    has(
      check({
        ...prov,
        files: [
          {
            ...entry,
            mode: "extracted",
          },
        ],
      }),
      "requires heading_path",
    );
    const outside = write("outside.cu", "private source");
    symlinkSync(outside, path.join(directory, "escape.cu"));
    has(
      check({
        ...prov,
        files: [
          entry,
          {
            ...entry,
            local_path: "escape.cu",
          },
        ],
      }),
      "escapes the bundle root",
    );
    rmSync(path.join(directory, "escape.cu"));
    write(`${bundle}/kernel.cu`, Buffer.alloc(v.FILE_SIZE_CAP_BYTES + 1));
    has(check(prov), "> 1048576 cap");
    assert.deepEqual(
      check({
        ...prov,
        files: [
          {
            ...entry,
            size_cap_truncated: true,
          },
        ],
      }),
      [],
    );
    write(`${bundle}/nested/PROVENANCE.yaml`, {});
    has(check(prov), "nested PROVENANCE.yaml disallowed");
    const orphan = write("artifacts/unowned.cu", "code");
    write("artifacts/blogs/metadata/MANIFEST.yaml", {});
    assert.deepEqual(v.findOrphanSourceFiles(), [orphan]);
  }));
test("contest submissions reject escape paths and require unavailable reasons", () =>
  fixture(({ root, write }) => {
    const schemas = {
      "source-contest": {
        submissions_schema: {
          required: ["submission_truth"],
          optional: ["code_path", "code_unavailable_reason"],
          constraints: {
            submission_truth: ["verbatim", "unavailable"],
          },
        },
      },
    };
    const filename = path.join(root, "sources/contests/contest/problem.md");
    const own = "artifacts/contests/contest/problem/submissions/rank-1/kernel.cu";
    write(own, "kernel");
    write("artifacts/contests/other/kernel.cu", "other");
    const check = (entry) =>
      v.validateContestSubmissions(
        {
          submissions: [entry],
        },
        filename,
        schemas,
      );
    assert.deepEqual(
      check({
        submission_truth: "verbatim",
        code_path: own,
      }),
      [],
    );
    has(
      check({
        submission_truth: "unavailable",
      }),
      "code_unavailable_reason",
    );
    has(
      check({
        submission_truth: "verbatim",
        code_path: "artifacts/contests/other/kernel.cu",
      }),
      "the page's own implicit submission bundle",
    );
    has(
      check({
        submission_truth: "verbatim",
        code_path: "absent.cu",
      }),
      "does not exist",
    );
    has(
      check({
        submission_truth: "wrong",
        extra: 1,
      }),
      "unknown field",
    );
    has(check("wrong"), "must be a mapping");
  }));
test("candidate ledger fixtures exercise valid and missing-field contracts", () => {
  assert.deepEqual(v.validateLedger(path.join(ROOT, "tests/fixtures/ledger-shape-valid.json")), []);
  has(
    v.validateLedger(path.join(ROOT, "tests/fixtures/ledger-shape-invalid.json")),
    "missing required top-level field 'keywords_used'",
  );
});
test("ledger summary, refresh coverage, subset and cutoff audits remain independent", () =>
  fixture(({ write, page }) => {
    const ledger = {
      repo: "example/project",
      searched_at: "2026-01-01",
      keywords_used: [],
      total_candidates: 1,
      included: 1,
      excluded: 0,
      deferred: 0,
      prs: [
        {
          number: 1,
          title: "Kernel",
          date: "2026-01-01",
          decision: "include",
          reason: "device",
        },
      ],
    };
    const filename = write("candidates/project.json", ledger);
    assert.deepEqual(v.validateLedger(filename), []);
    has(v.validateSkipAuditCoverage(), "neither sources/prs/project/PR-1.md");
    write("data/pr-page-skipped.json", {
      rows: [
        {
          repo: "example/project",
          pr_number: 1,
        },
      ],
    });
    assert.deepEqual(v.validateSkipAuditCoverage(), []);
    write("data/refresh-cutoff.json", {
      cutoff_date: "2026-02-01",
      previous_pages_manifest: ["sources/prs/project/PR-1.md"],
    });
    has(v.validateRefreshCutoffAlignment(), "searched_at");
    write("data/refresh-search-results.json", {
      repos: [
        {
          repo_slug: "project",
          pr_numbers_seen: [1, 2],
        },
      ],
    });
    has(v.validateRefreshSubset(), "first 5: [2]");
    page("sources/prs/project/PR-1.md", {
      captured_at: "2026-01-01",
    });
    assert.deepEqual(v.validateCapturedAtCutoff(), []);
    page("sources/prs/project/PR-2.md", {
      captured_at: "2026-01-01",
    });
    has(v.validateCapturedAtCutoff(), "page is new this round");
    write("candidates/project.json", {
      ...ledger,
      included: 2,
    });
    has(v.validateLedger(filename), "disagrees with row count");
    has(v.validateLedger(filename), "included + excluded + deferred");
  }));
test("registry pointers, obsolete claims, dev pinning and plan immutability all fail closed", () =>
  fixture(({ write, page }) => {
    const claim = {
      id: "claim",
      source_ids: ["doc-source"],
      applies_to: ["wiki/languages/example.md"],
      dev_branch_sha: "a".repeat(40),
    };
    write("data/version-claims.json", {
      claims: [claim],
    });
    page(
      "wiki/languages/example.md",
      {
        version_sensitive: "claim",
        confidence: "source-reported",
      },
      "CUTLASS 4.5-dev; no direct tcgen05 access.",
    );
    assert.deepEqual(v.validateVersionClaimsRegistry(new Set(["doc-source"])), []);
    assert.deepEqual(v.validateCutlassDevPinning(), []);
    assert.deepEqual(v.validateClaimBearingPagesHavePointer(), []);
    page(
      "wiki/languages/example.md",
      {
        confidence: "verified",
      },
      "CUTLASS 4.5-dev; no direct tcgen05 access.",
    );
    has(v.validateVersionClaimsRegistry(new Set()), "source_id 'doc-source' does not resolve");
    has(v.validateVersionClaimsRegistry(new Set()), "AC-2 reverse direction");
    has(v.validateCutlassDevPinning(), "verified pages cite stable releases only");
    has(v.validateClaimBearingPagesHavePointer(), "lacks version_sensitive");
    page(
      "wiki/languages/example.md",
      {},
      "## Pre-3.6 historical context\nno direct tcgen05 access\n## Current\nSupported.",
    );
    assert.deepEqual(v.validateClaimBearingPagesHavePointer(), []);
    page(
      "wiki/languages/example.md",
      {
        id: "example",
      },
      "## Pre-3.6 historical context\nno direct tcgen05 access\n## Current\nno direct tcgen05 access",
    );
    has(v.validateClaimBearingPagesHavePointer(), "lacks version_sensitive");
    write("plan-phase2.md", "# Plan\n\n> Superseded by phase4\n\nOriginal body\n");
    write("data/plan-supersession-baselines/plan-phase2.body.md", "# Plan\n\nOriginal body\n");
    assert.deepEqual(v.validatePlanSupersession(), []);
    assert.deepEqual(v.validatePlanBodyUnchanged(), []);
    write("plan-phase2.md", "# Plan\n\nChanged body\n");
    has(v.validatePlanSupersession(), "missing supersession header");
    has(v.validatePlanBodyUnchanged(), "body content");
    write("references/supersession.md", "Wrong mechanism");
    has(v.validatePlanSupersession(), "must not exist");
  }));
test("cap receipt discovers the dynamic capped roster and verifies policy digest", () =>
  fixture(({ write, page }) => {
    const policy = readFileSync(path.join(ROOT, "scripts/lib/pr-policy.mjs"));
    write("scripts/lib/pr-policy.mjs", policy);
    write("candidates/project.json", {
      repo: "example/project",
      prs: [
        {
          number: 1,
          files_reviewed_count: 3001,
        },
      ],
    });
    const row = {
      repo: "example/project",
      pr: 1,
      authoritative_changed_files: 3001,
      files_api_enumerated: 3000,
      full_diff_paths: 3001,
      full_diff_complete: true,
      enumeration_complete: false,
      complete_file_evidence: [],
      disposition: "removed",
      full_policy: {
        retain: false,
        disposition: "removed",
      },
    };
    const receipt = {
      policy_sha256: v.sha256OfFile(path.join(v.REPO_ROOT, "scripts/lib/pr-policy.mjs")),
      rows: [row],
    };
    write("data/evidence/pr-file-cap-reconstruction.json", JSON.stringify(receipt));
    assert.deepEqual(v.validateCapReconstructionReceipt(), []);
    page("sources/prs/project/PR-1.md", {
      repo: "example/project",
      pr: 1,
    });
    has(v.validateCapReconstructionReceipt(), "removed page exists");
    write(
      "data/evidence/pr-file-cap-reconstruction.json",
      JSON.stringify({
        ...receipt,
        rows: [],
      }),
    );
    has(v.validateCapReconstructionReceipt(), "capped candidate roster mismatch");
    write(
      "data/evidence/pr-file-cap-reconstruction.json",
      JSON.stringify({
        ...receipt,
        policy_sha256: "old",
      }),
    );
    has(v.validateCapReconstructionReceipt(), "pr-policy.mjs digest mismatch");
  }));
function corpusFixture({ root, write }) {
  for (const name of ["sources", "wiki", "artifacts", "candidates", "references"]) {
    symlinkSync(path.join(ROOT, name), path.join(root, name), "dir");
  }
  cpSync(path.join(ROOT, "data"), path.join(root, "data"), {
    recursive: true,
  });
  for (const name of readdirSync(ROOT).filter((name) => /^plan-phase.*\.md$/.test(name))) {
    symlinkSync(path.join(ROOT, name), path.join(root, name));
  }
  write("scripts/lib/pr-policy.mjs", readFileSync(path.join(ROOT, "scripts/lib/pr-policy.mjs")));
  const digest = v.sha256OfFile(path.join(root, "scripts/lib/pr-policy.mjs"));
  for (const name of [
    "data/evidence/pr-architecture.json",
    "data/evidence/pr-file-cap-reconstruction.json",
  ]) {
    const receipt = JSON.parse(readFileSync(path.join(ROOT, name), "utf8"));
    receipt.policy_sha256 = digest;
    write(name, JSON.stringify(receipt));
  }
}
test("validator CLI preserves all 29 known errors after fixture receipt migration", () =>
  fixture((context) => {
    corpusFixture(context);
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/validate.mjs")], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        BLACKWELL_WIKI_ROOT: context.root,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr);
    const errors = result.stdout.split("\n").filter((line) => line.startsWith("  ERROR: "));
    assert.equal(errors.length, 29, result.stdout);
    assert.equal(
      errors.filter((line) =>
        line.includes("wiki/patterns/coalesced-warp-mapping-memory-bound.md:"),
      ).length,
      10,
    );
    const sanitized = corpusData("SANITIZED.yaml");
    assert.equal(sanitized.removed, 19);
    const missing = errors.filter((line) => line.includes("does not exist in bundle"));
    assert.equal(missing.length, 19);
    for (const name of sanitized.files) {
      const [, bundle, local] = /^(.*\/PR-\d+)\/(.*)$/.exec(name);
      assert.ok(
        missing.some(
          (line) =>
            line.includes(`${bundle}/PROVENANCE.yaml:`) && line.includes(`local_path '${local}'`),
        ),
        name,
      );
    }
    assert.ok(result.stdout.includes("Validated 1042 files (989 source IDs collected)"));
    assert.ok(
      result.stdout.includes(
        "Validated 37 asset bundles (verbatim=37, extracted=0, derived=0, orphan-source-files=0)",
      ),
    );
  }));
