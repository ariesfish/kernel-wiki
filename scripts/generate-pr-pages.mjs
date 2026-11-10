#!/usr/bin/env node
/** Generate source PR pages from candidate ledgers and authoritative GitHub evidence. */
import { readJson, writeJson } from "./lib/json.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { WIKI_ROOT } from "./lib/root.mjs";
import { stringifyMaintenance as stringify } from "./lib/yaml.mjs";
import {
  BODY_CONTRACT,
  classifyScope,
  deriveArchitectures,
  deriveMetadata,
  normalizeFiles,
  renderGeneratedBody,
  upstreamFilesSha256,
} from "./lib/pr-policy.mjs";
import { ghJson, isoDate, REPO_SLUG_TO_FULL } from "./refresh-candidate-ledger.mjs";
export const REPO_ROOT = WIKI_ROOT;
export const TAGS_PATH = path.join(REPO_ROOT, "data/tags.json");
export const PR_PAGE_SKIPPED_PATH = path.join(REPO_ROOT, "data/pr-page-skipped.json");
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const dump = (value, lineWidth = 80) =>
  stringify(value, {
    version: "1.1",
    indentSeq: false,
    lineWidth,
  });
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
export function ghApi(endpoint) {
  try {
    return ghJson(["api", endpoint], 30_000);
  } catch {
    return null;
  }
}
export function fetchPr(repo, number, request = ghApi) {
  return request(`repos/${repo}/pulls/${number}`);
}
export function fetchPrFiles(repo, number, request = ghApi) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const rows = request(`repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) {
      return [];
    }
    files.push(...rows);
    if (rows.length < 100) {
      return files;
    }
  }
  throw new Error(`PR ${repo}#${number} exceeds GitHub's 3000 changed-file API limit`);
}
export function isKernelRelated(title, files, body = "") {
  const decision = classifyScope(title, body, files);
  return [decision.retain, decision.reason];
}
export function autoTag(title, files, body = "", scope = null) {
  const metadata = deriveMetadata(title, body, files, scope);
  return [
    metadata.tags,
    metadata.hardware_features,
    metadata.kernel_types,
    metadata.techniques,
    metadata.languages,
  ];
}
export function generatePage(repo, prData, files, inclusionReason, capturedAt, preserved = null) {
  const repoSlug = repo.split("/")[1];
  const { number, title } = prData;
  const body = prData.body || "";
  const normalized = normalizeFiles(files);
  const scope = classifyScope(title, body, normalized);
  const [architectures, architectureDisposition, architectureEvidence] = deriveArchitectures(
    title,
    body,
    normalized,
  );
  const [tags, hardwareFeatures, kernelTypes, techniques, languages] = autoTag(
    title,
    normalized,
    body,
    scope,
  );
  const allPaths = normalized.map((item) => item.filename);
  const evidencePaths = [...scope.evidence_paths];
  for (const row of architectureEvidence) {
    const locator = row.locator || "";
    for (const prefix of ["changed-path:", "added-patch:"]) {
      if (locator.startsWith(prefix)) {
        evidencePaths.push(locator.slice(prefix.length));
      }
    }
  }
  const displayPaths = [...new Set([...allPaths.slice(0, 25), ...evidencePaths])];
  const authoritative = Number(prData.changed_files || allPaths.length);
  if (!Number.isInteger(authoritative) || authoritative < allPaths.length) {
    throw new Error(
      `PR ${repo}#${number} reports changed_files=${authoritative} but ${allPaths.length} file records were supplied`,
    );
  }
  const enumerated = Number(prData.changed_files_enumerated_count ?? allPaths.length);
  const listingComplete = Boolean(
    prData.changed_files_listing_complete ?? enumerated === authoritative,
  );
  const [renderedBody, excerptHash] = renderGeneratedBody(body, displayPaths, authoritative);
  const status =
    prData.merged || prData.merged_at ? "merged" : String(prData.state || "closed").toLowerCase();
  if (status === "merged" && !prData.merge_commit_sha) {
    throw new Error(`PR ${repo}#${number} is merged but has no merge_commit_sha`);
  }
  const fm = {
    id: `pr-${repoSlug}-${number}`,
    repo,
    pr: number,
    title,
    author: prData.user.login,
    date: prData.created_at.slice(0, 10),
    url: prData.html_url,
    source_category: "upstream-code",
    architectures,
    architecture_disposition: architectureDisposition,
    architecture_evidence: architectureEvidence,
    tags,
    techniques,
    hardware_features: hardwareFeatures,
    kernel_types: kernelTypes,
    languages,
    captured_at: capturedAt,
    status,
    ...(status === "merged"
      ? {
          merge_sha: String(prData.merge_commit_sha),
        }
      : {}),
    inclusion_reason: scope.reason,
    scope_disposition: scope.disposition,
    scope_evidence: {
      rule: scope.rule,
      paths: [...scope.evidence_paths],
    },
    changed_files_count: authoritative,
    changed_files_enumerated_count: enumerated,
    changed_files_listing_complete: listingComplete,
    changed_paths: displayPaths,
    changed_paths_complete: listingComplete && displayPaths.length === authoritative,
    body_contract: BODY_CONTRACT,
    upstream_body_locator: `${prData.html_url} (PR description)`,
    upstream_body_sha256: sha256(body),
    upstream_excerpt_sha256: excerptHash,
    upstream_files_sha256: upstreamFilesSha256(normalized),
    upstream_patches_complete:
      prData.patches_complete ?? normalized.every((item) => item.patch != null),
  };
  if (prData.changed_files_evidence_method) {
    Object.assign(fm, {
      changed_files_evidence_count: allPaths.length,
      changed_files_evidence_complete: allPaths.length === authoritative,
      changed_files_evidence_method: prData.changed_files_evidence_method,
      changed_files_evidence_receipt: prData.changed_files_evidence_receipt,
    });
    fm.scope_evidence.path_source = prData.changed_files_evidence_method;
  }
  if (preserved?.artifact_dir) {
    fm.artifact_dir = preserved.artifact_dir;
  }
  return `---\n${dump(fm)}---\n\n${renderedBody}`;
}
export function loadSkipAudit(file = PR_PAGE_SKIPPED_PATH) {
  if (!fs.existsSync(file)) {
    return new Map();
  }
  const data = readJson(file) || {};
  return new Map((data.rows || []).map((row) => [`${row.repo}#${row.pr_number}`, row]));
}
export function writeSkipAudit(auditMap, file = PR_PAGE_SKIPPED_PATH) {
  const rows = [...auditMap.values()].sort((a, b) =>
    a.repo < b.repo
      ? -1
      : a.repo > b.repo
        ? 1
        : a.pr_number < b.pr_number
          ? -1
          : a.pr_number > b.pr_number
            ? 1
            : 0,
  );
  writeJson(file, {
    rows,
  });
}
export function recordSkip(auditMap, repo, prNumber, stage, reason, capturedAt) {
  auditMap.set(`${repo}#${prNumber}`, {
    pr_id: `pr-${repo.split("/")[1]}-${prNumber}`,
    repo,
    pr_number: prNumber,
    stage,
    reason,
    recorded_at: capturedAt,
  });
}
export function processLedger(
  ledgerPath,
  maxPages = null,
  capturedAt = null,
  auditMap = null,
  dependencies = {},
) {
  const root = dependencies.root || REPO_ROOT;
  const ledger = readJson(ledgerPath);
  const slug = path.basename(ledgerPath, path.extname(ledgerPath));
  const repo = ledger.repo || REPO_SLUG_TO_FULL[slug] || `unknown/${slug}`;
  const outdir = path.join(root, "sources/prs", repo.split("/")[1]);
  fs.mkdirSync(outdir, {
    recursive: true,
  });
  const existing = new Set(
    fs
      .readdirSync(outdir)
      .map((name) => /^PR-(\d+)\.md$/.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1])),
  );
  const candidates = ledger[Object.hasOwn(ledger, "prs") ? "prs" : "candidates"] || [];
  const included = candidates.filter(
    (row) => String(row.decision || "").toLowerCase() === "include" && !existing.has(row.number),
  );
  capturedAt = capturedAt == null ? today() : isoDate(capturedAt);
  console.log(
    `\n${repo}: ${included.length} new PRs to process (${existing.size} already exist)\n  captured_at = ${capturedAt}`,
  );
  if (maxPages) {
    console.log(`  Target: stop after generating ${maxPages} pages`);
  }
  let generated = 0,
    skipped = 0;
  for (const [i, candidate] of included.entries()) {
    if (maxPages && generated >= maxPages) {
      console.log(`  Reached target of ${maxPages} generated pages`);
      break;
    }
    const pr = (dependencies.fetchPr || fetchPr)(repo, candidate.number);
    if (!pr) {
      skipped++;
      if (auditMap !== null) {
        recordSkip(
          auditMap,
          repo,
          candidate.number,
          "pre-fetch",
          "gh pr fetch returned no data",
          capturedAt,
        );
      }
      continue;
    }
    const files = (dependencies.fetchPrFiles || fetchPrFiles)(repo, candidate.number);
    const [retain, reason] = isKernelRelated(
      pr.title || candidate.title || "",
      files,
      pr.body || "",
    );
    if (!retain) {
      skipped++;
      if (auditMap !== null) {
        recordSkip(auditMap, repo, candidate.number, "is-kernel-related", reason, capturedAt);
      }
      continue;
    }
    fs.writeFileSync(
      path.join(outdir, `PR-${candidate.number}.md`),
      generatePage(repo, pr, files, reason, capturedAt),
    );
    generated++;
    if (generated % 10 === 0) {
      console.log(`  Generated ${generated} pages so far...`);
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  Progress: ${i + 1}/${included.length}`);
    }
  }
  console.log(`  Done: ${generated} generated, ${skipped} skipped, ${existing.size} pre-existing`);
  return generated;
}
export function main(argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        all: {
          type: "boolean",
        },
        max: {
          type: "string",
        },
        "captured-at": {
          type: "string",
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    });
    if (values.help || (!values.all && !positionals.length)) {
      console.log(
        "Usage: node scripts/generate-pr-pages.mjs candidates/cutlass.json [--max=N] [--captured-at=YYYY-MM-DD]\n       node scripts/generate-pr-pages.mjs --all [--max=N] [--captured-at=YYYY-MM-DD]",
      );
      return 0;
    }
    if (values.max !== undefined && !/^[+-]?\d+$/.test(values.max)) {
      throw new Error("--max requires an integer");
    }
    const maxPages = values.max === undefined ? null : Number(values.max);
    const capturedAt = values["captured-at"] === undefined ? null : isoDate(values["captured-at"]);
    const audit = loadSkipAudit();
    if (values.all) {
      for (const file of fs
        .readdirSync(path.join(REPO_ROOT, "candidates"))
        .filter((name) => name.endsWith(".json"))
        .sort()) {
        processLedger(path.join(REPO_ROOT, "candidates", file), maxPages, capturedAt, audit);
      }
    } else {
      processLedger(positionals[0], maxPages, capturedAt, audit);
    }
    writeSkipAudit(audit);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
