import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as validate from "../scripts/validate.mjs";
function fixture() {
  const fm = {
    upstream_body_sha256: "a".repeat(64),
    upstream_files_sha256: "b".repeat(64),
    architectures: [],
    architecture_disposition: "unknown",
    architecture_evidence: [
      {
        architecture: "unknown",
        basis: "explicit-unknown",
        locator: "complete upstream evidence",
        evidence: "No supported architecture signal.",
      },
    ],
  };
  const rows = {
    "tilelang/PR-2198.md": validate.architectureReceiptRecord(fm),
  };
  const receipt = {
    schema_version: 1,
    policy_sha256: createHash("sha256")
      .update(readFileSync(new URL("../scripts/lib/pr-policy.mjs", import.meta.url)))
      .digest("hex"),
    row_fields: [
      "upstream_body_sha256",
      "upstream_files_sha256",
      "architectures",
      "architecture_disposition",
      "architecture_evidence_sha256",
    ],
    rows: structuredClone(rows),
  };
  return {
    fm,
    rows,
    receipt,
  };
}
test("exact receipt match is clean", () => {
  const { rows, receipt } = fixture();
  assert.deepEqual(validate.comparePrArchitectureReceipt(rows, receipt), []);
});
test("coherently fabricated page fails receipt", () => {
  const { fm, receipt } = fixture();
  fm.architectures = ["sm100"];
  fm.architecture_disposition = "exact";
  fm.architecture_evidence = [
    {
      architecture: "sm100",
      basis: "exact-sm-token",
      locator: "fabricated",
      evidence: "SM100",
    },
  ];
  const errors = validate.comparePrArchitectureReceipt(
    {
      "tilelang/PR-2198.md": validate.architectureReceiptRecord(fm),
    },
    receipt,
  );
  assert.ok(errors.some((error) => error.includes("architecture receipt mismatch")));
});
test("receipt detects missing, unexpected, stale-policy and malformed contracts", () => {
  const { rows, receipt } = fixture();
  assert.match(
    validate.comparePrArchitectureReceipt({}, receipt).join("\n"),
    /receipted page\(s\) missing/,
  );
  assert.match(
    validate
      .comparePrArchitectureReceipt(
        {
          ...rows,
          unexpected: [],
        },
        receipt,
      )
      .join("\n"),
    /unreceipted page/,
  );
  assert.match(
    validate
      .comparePrArchitectureReceipt(rows, {
        ...receipt,
        policy_sha256: "bad",
      })
      .join("\n"),
    /pr-policy\.mjs digest mismatch/,
  );
  assert.match(
    validate
      .comparePrArchitectureReceipt(rows, {
        ...receipt,
        row_fields: [],
      })
      .join("\n"),
    /row_fields contract mismatch/,
  );
  assert.match(validate.comparePrArchitectureReceipt(rows, null).join("\n"), /schema_version/);
  assert.match(
    validate
      .comparePrArchitectureReceipt(rows, {
        schema_version: 1,
        rows: [],
      })
      .join("\n"),
    /rows must be a mapping/,
  );
});
test("receipt evidence digest preserves Python canonical JSON including Unicode", () => {
  const evidence = [
    {
      z: "é😀",
      a: {
        z: 2,
        a: 1,
      },
    },
  ];
  const expected = createHash("sha256")
    .update('[{"a":{"a":1,"z":2},"z":"\\u00e9\\ud83d\\ude00"}]')
    .digest("hex");
  assert.equal(
    validate.architectureReceiptRecord({
      architecture_evidence: evidence,
    })[4],
    expected,
  );
});
