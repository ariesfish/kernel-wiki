#!/usr/bin/env node
/** Generate source PR pages from candidate ledgers and authoritative GitHub evidence. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { WIKI_ROOT } from "./lib/root.mjs";
import { parseMaintenance as parse, stringifyMaintenance as stringify } from "./lib/yaml.mjs";
import { BODY_CONTRACT, classify_scope, derive_architectures, derive_metadata, normalize_files, render_generated_body, upstream_files_sha256 } from "./lib/pr-policy.mjs";
import { REPO_SLUG_TO_FULL, gh_json, iso_date } from "./refresh-candidate-ledger.mjs";

export const REPO_ROOT = WIKI_ROOT;
export const TAGS_PATH = path.join(REPO_ROOT, "data/tags.yaml");
export const PR_PAGE_SKIPPED_PATH = path.join(REPO_ROOT, "data/pr-page-skipped.yaml");
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const dump = (value, lineWidth = 80) => stringify(value, { version: "1.1", indentSeq: false, lineWidth });
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; };

export function gh_api(endpoint) {
  try { return gh_json(["api", endpoint], 30_000); } catch { return null; }
}
export function fetch_pr(repo, number, request = gh_api) { return request(`repos/${repo}/pulls/${number}`); }
export function fetch_pr_files(repo, number, request = gh_api) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const rows = request(`repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) return [];
    files.push(...rows);
    if (rows.length < 100) return files;
  }
  throw new Error(`PR ${repo}#${number} exceeds GitHub's 3000 changed-file API limit`);
}
export function is_kernel_related(title, files, body = "") {
  const decision = classify_scope(title, body, files);
  return [decision.retain, decision.reason];
}
export function auto_tag(title, files, body = "", scope = null) {
  const metadata = derive_metadata(title, body, files, scope);
  return [metadata.tags, metadata.hardware_features, metadata.kernel_types, metadata.techniques, metadata.languages];
}

export function generate_page(repo, pr_data, files, inclusion_reason, captured_at, preserved = null) {
  const repo_slug = repo.split("/")[1];
  const { number, title } = pr_data;
  const body = pr_data.body || "";
  const normalized = normalize_files(files);
  const scope = classify_scope(title, body, normalized);
  const [architectures, architecture_disposition, architecture_evidence] = derive_architectures(title, body, normalized);
  const [tags, hardware_features, kernel_types, techniques, languages] = auto_tag(title, normalized, body, scope);
  const all_paths = normalized.map((item) => item.filename);
  const evidence_paths = [...scope.evidence_paths];
  for (const row of architecture_evidence) {
    const locator = row.locator || "";
    for (const prefix of ["changed-path:", "added-patch:"]) if (locator.startsWith(prefix)) evidence_paths.push(locator.slice(prefix.length));
  }
  const display_paths = [...new Set([...all_paths.slice(0, 25), ...evidence_paths])];
  const authoritative = Number(pr_data.changed_files || all_paths.length);
  if (!Number.isInteger(authoritative) || authoritative < all_paths.length) throw new Error(`PR ${repo}#${number} reports changed_files=${authoritative} but ${all_paths.length} file records were supplied`);
  const enumerated = Number(pr_data.changed_files_enumerated_count ?? all_paths.length);
  const listing_complete = Boolean(pr_data.changed_files_listing_complete ?? (enumerated === authoritative));
  const [rendered_body, excerpt_hash] = render_generated_body(body, display_paths, authoritative);
  const status = pr_data.merged || pr_data.merged_at ? "merged" : String(pr_data.state || "closed").toLowerCase();
  if (status === "merged" && !pr_data.merge_commit_sha) throw new Error(`PR ${repo}#${number} is merged but has no merge_commit_sha`);
  const fm = {
    id: `pr-${repo_slug}-${number}`, repo, pr: number, title, author: pr_data.user.login,
    date: pr_data.created_at.slice(0, 10), url: pr_data.html_url, source_category: "upstream-code",
    architectures, architecture_disposition, architecture_evidence, tags, techniques, hardware_features, kernel_types, languages,
    captured_at, status, ...(status === "merged" ? { merge_sha: String(pr_data.merge_commit_sha) } : {}),
    inclusion_reason: scope.reason, scope_disposition: scope.disposition,
    scope_evidence: { rule: scope.rule, paths: [...scope.evidence_paths] },
    changed_files_count: authoritative, changed_files_enumerated_count: enumerated,
    changed_files_listing_complete: listing_complete, changed_paths: display_paths,
    changed_paths_complete: listing_complete && display_paths.length === authoritative,
    body_contract: BODY_CONTRACT, upstream_body_locator: `${pr_data.html_url} (PR description)`,
    upstream_body_sha256: sha256(body), upstream_excerpt_sha256: excerpt_hash,
    upstream_files_sha256: upstream_files_sha256(normalized),
    upstream_patches_complete: pr_data.patches_complete ?? normalized.every((item) => item.patch != null),
  };
  if (pr_data.changed_files_evidence_method) {
    Object.assign(fm, { changed_files_evidence_count: all_paths.length, changed_files_evidence_complete: all_paths.length === authoritative,
      changed_files_evidence_method: pr_data.changed_files_evidence_method, changed_files_evidence_receipt: pr_data.changed_files_evidence_receipt });
    fm.scope_evidence.path_source = pr_data.changed_files_evidence_method;
  }
  if (preserved?.artifact_dir) fm.artifact_dir = preserved.artifact_dir;
  return `---\n${dump(fm)}---\n\n${rendered_body}`;
}

export function load_skip_audit(file = PR_PAGE_SKIPPED_PATH) {
  if (!fs.existsSync(file)) return new Map();
  const data = parse(fs.readFileSync(file, "utf8")) || {};
  return new Map((data.rows || []).map((row) => [`${row.repo}#${row.pr_number}`, row]));
}
export function write_skip_audit(audit_map, file = PR_PAGE_SKIPPED_PATH) {
  const rows = [...audit_map.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.pr_number - b.pr_number));
  const header = "## AC-4 PR-page skip audit. Schema: data/schemas.yaml ::\n## pr-page-skipped-audit. Sort key: (repo, pr_number) ascending.\n## Byte-stable for identical inputs (regen-deterministic).\n##\n## Stages owned by scripts/generate-pr-pages.mjs:\n##   pre-fetch         -> gh PR fetch returned no data\n##   is-kernel-related -> file-allowlist check excluded the PR\n##\n";
  fs.writeFileSync(file, header + dump({ rows }, 200));
}
export function record_skip(audit_map, repo, pr_number, stage, reason, captured_at) {
  audit_map.set(`${repo}#${pr_number}`, { pr_id: `pr-${repo.split("/")[1]}-${pr_number}`, repo, pr_number, stage, reason, recorded_at: captured_at });
}

export function process_ledger(ledger_path, max_pages = null, captured_at = null, audit_map = null, dependencies = {}) {
  const root = dependencies.root || REPO_ROOT;
  const ledger = parse(fs.readFileSync(ledger_path, "utf8"));
  const slug = path.basename(ledger_path, path.extname(ledger_path));
  const repo = ledger.repo || REPO_SLUG_TO_FULL[slug] || `unknown/${slug}`;
  const outdir = path.join(root, "sources/prs", repo.split("/")[1]);
  fs.mkdirSync(outdir, { recursive: true });
  const existing = new Set(fs.readdirSync(outdir).map((name) => /^PR-(\d+)\.md$/.exec(name)).filter(Boolean).map((match) => Number(match[1])));
  const candidates = ledger[Object.hasOwn(ledger, "prs") ? "prs" : "candidates"] || [];
  const included = candidates.filter((row) => String(row.decision || "").toLowerCase() === "include" && !existing.has(row.number));
  captured_at = captured_at == null ? today() : iso_date(captured_at);
  console.log(`\n${repo}: ${included.length} new PRs to process (${existing.size} already exist)\n  captured_at = ${captured_at}`);
  if (max_pages) console.log(`  Target: stop after generating ${max_pages} pages`);
  let generated = 0, skipped = 0;
  for (const [i, candidate] of included.entries()) {
    if (max_pages && generated >= max_pages) { console.log(`  Reached target of ${max_pages} generated pages`); break; }
    const pr = (dependencies.fetch_pr || fetch_pr)(repo, candidate.number);
    if (!pr) {
      skipped++;
      if (audit_map !== null) record_skip(audit_map, repo, candidate.number, "pre-fetch", "gh pr fetch returned no data", captured_at);
      continue;
    }
    const files = (dependencies.fetch_pr_files || fetch_pr_files)(repo, candidate.number);
    const [retain, reason] = is_kernel_related(pr.title || candidate.title || "", files, pr.body || "");
    if (!retain) {
      skipped++;
      if (audit_map !== null) record_skip(audit_map, repo, candidate.number, "is-kernel-related", reason, captured_at);
      continue;
    }
    fs.writeFileSync(path.join(outdir, `PR-${candidate.number}.md`), generate_page(repo, pr, files, reason, captured_at));
    generated++;
    if (generated % 10 === 0) console.log(`  Generated ${generated} pages so far...`);
    if ((i + 1) % 50 === 0) console.log(`  Progress: ${i + 1}/${included.length}`);
  }
  console.log(`  Done: ${generated} generated, ${skipped} skipped, ${existing.size} pre-existing`);
  return generated;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean" }, max: { type: "string" }, "captured-at": { type: "string" }, help: { type: "boolean", short: "h" } } });
    if (values.help || (!values.all && !positionals.length)) { console.log("Usage: node scripts/generate-pr-pages.mjs candidates/cutlass.yaml [--max=N] [--captured-at=YYYY-MM-DD]\n       node scripts/generate-pr-pages.mjs --all [--max=N] [--captured-at=YYYY-MM-DD]"); return 0; }
    if (values.max !== undefined && !/^[+-]?\d+$/.test(values.max)) throw new Error("--max requires an integer");
    const max_pages = values.max === undefined ? null : Number(values.max);
    const captured_at = values["captured-at"] === undefined ? null : iso_date(values["captured-at"]);
    const audit = load_skip_audit();
    if (values.all) for (const file of fs.readdirSync(path.join(REPO_ROOT, "candidates")).filter((name) => name.endsWith(".yaml")).sort()) process_ledger(path.join(REPO_ROOT, "candidates", file), max_pages, captured_at, audit);
    else process_ledger(positionals[0], max_pages, captured_at, audit);
    write_skip_audit(audit);
    return 0;
  } catch (error) { console.error(`ERROR: ${error.message}`); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
