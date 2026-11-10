#!/usr/bin/env node
/** Refresh candidate ledgers using GitHub evidence; offline checks never import this CLI. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WIKI_ROOT } from "./lib/root.mjs";
import { parseMaintenance as parse, stringifyMaintenance as stringify } from "./lib/yaml.mjs";
import { classify_scope } from "./lib/pr-policy.mjs";

export const REPO_ROOT = WIKI_ROOT;
export const CANDIDATES_DIR = path.join(REPO_ROOT, "candidates");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const REFRESH_CUTOFF_PATH = path.join(DATA_DIR, "refresh-cutoff.yaml");
export const REFRESH_RESULTS_PATH = path.join(DATA_DIR, "refresh-search-results.yaml");
export const REPO_SLUG_TO_FULL = {
  cutlass: "NVIDIA/cutlass", sglang: "sgl-project/sglang", vllm: "vllm-project/vllm",
  flashinfer: "flashinfer-ai/flashinfer", pytorch: "pytorch/pytorch", deepgemm: "deepseek-ai/DeepGEMM",
  "flash-attention": "Dao-AILab/flash-attention", "tensorrt-llm": "NVIDIA/TensorRT-LLM",
  "cccl-cub": "NVIDIA/cccl", triton: "triton-lang/triton", tilelang: "tile-ai/tilelang",
  thunderkittens: "HazyResearch/ThunderKittens", tilekernels: "deepseek-ai/TileKernels", quack: "Dao-AILab/quack",
};
const dump = (value) => stringify(value, { version: "1.1", indentSeq: false, lineWidth: 200 });
const mapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function iso_date(value) {
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number(text.slice(0, 4)) < 1) throw new Error(`Invalid ISO date: ${text}`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error(`Invalid ISO date: ${text}`);
  return text;
}

export function gh_json(args, timeout = 60_000) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `gh exited ${result.status}`);
  return JSON.parse(result.stdout);
}

export async function gh_search_prs(repo_full, keywords, cutoff_date, per_keyword_limit = 30, sleep_between_kw = 2.5, request = gh_json) {
  if (!keywords?.length) return [];
  const cutoff = iso_date(cutoff_date);
  const seen = new Map();
  for (const keyword of keywords) {
    try {
      const rows = await request(["search", "prs", "--repo", repo_full, "--state", "closed", "--merged", "--limit", String(per_keyword_limit), "--json", "number,title,closedAt,url", keyword]);
      for (const row of rows) {
        const closedAt = (row.closedAt || "").slice(0, 10);
        if (closedAt && closedAt <= cutoff && !seen.has(row.number)) seen.set(row.number, { number: row.number, title: row.title || "", closedAt });
      }
    } catch (error) {
      console.error(`WARN: gh search failed for ${repo_full} kw=${JSON.stringify(keyword)}: ${error.message}`);
    }
    if (sleep_between_kw > 0) await delay(sleep_between_kw * 1000);
  }
  return [...seen.values()];
}

export function fetch_pr_evidence(repo_full, number, request = gh_json) {
  try {
    const pr = request(["api", `repos/${repo_full}/pulls/${number}`]);
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const rows = request(["api", `repos/${repo_full}/pulls/${number}/files?per_page=100&page=${page}`]);
      if (!Array.isArray(rows)) return null;
      files.push(...rows);
      if (rows.length < 100) return [pr, files];
    }
  } catch { return null; }
  return null;
}

export function classify_search_hit(repo_full, hit, evidence_fetcher = fetch_pr_evidence) {
  const evidence = evidence_fetcher(repo_full, hit.number);
  if (evidence == null) return ["defer", "authoritative PR evidence unavailable; needs-triage", []];
  const [pr, files] = evidence;
  const decision = classify_scope(pr.title || hit.title || "", pr.body || "", files);
  return [decision.retain ? "include" : "exclude", decision.reason, files.filter((item) => item.filename).map((item) => item.filename)];
}

export function update_ledger(ledger_path, cutoff_date, search_results, repo_full = null, evidence_fetcher = fetch_pr_evidence) {
  const data = parse(fs.readFileSync(ledger_path, "utf8"));
  if (!mapping(data)) return undefined;
  data.searched_at = iso_date(cutoff_date);
  const existing = new Set((data.prs || []).filter(mapping).map((row) => row.number));
  const additions = [];
  for (const hit of search_results) {
    if (existing.has(hit.number)) continue;
    const [decision, reason, paths] = classify_search_hit(repo_full || data.repo || "", hit, evidence_fetcher);
    additions.push({ number: hit.number, title: hit.title || "", date: hit.closedAt || "", decision, reason, files_changed: paths });
  }
  if (additions.length) {
    data.prs = [...(data.prs || []), ...additions];
    const count = (decision) => data.prs.filter((row) => String(row.decision || "").toLowerCase() === decision).length;
    data.included = count("include"); data.excluded = count("exclude"); data.deferred = count("defer");
    data.total_candidates = data.included + data.excluded + data.deferred;
  }
  fs.writeFileSync(ledger_path, dump(data));
  return additions.length;
}

export function write_cutoff(cutoff_date, output = REFRESH_CUTOFF_PATH) {
  const header = "## Round-N refresh cutoff record. Schema: data/schemas.yaml ::\n## refresh-cutoff. Updated by scripts/refresh-candidate-ledger.mjs.\n##\n## All candidates/*.yaml::searched_at fields must equal this date\n## after a refresh round (per AC-5).\n";
  fs.writeFileSync(output, header + dump({ cutoff_date: iso_date(cutoff_date) }));
}

export function write_search_results(cutoff_date, per_repo, output = REFRESH_RESULTS_PATH) {
  const cutoff = iso_date(cutoff_date);
  const repos = Object.keys(per_repo).sort().map((repo_slug) => {
    const rows = per_repo[repo_slug];
    return { repo_slug, searched_at: cutoff, cutoff_date_used: cutoff, pr_numbers_seen: rows.map((row) => row.number).sort((a, b) => a - b), last_pr_date_seen: rows.map((row) => row.closedAt).sort().at(-1) || "" };
  });
  const header = "## AC-5 refresh search-results record. Schema: data/schemas.yaml ::\n## refresh-search-results. Generated by\n## scripts/refresh-candidate-ledger.mjs. Byte-stable for identical\n## query inputs (pr_numbers_seen sorted ascending; repos keyed by\n## repo_slug ascending).\n";
  fs.writeFileSync(output, header + dump({ cutoff_date: cutoff, repos }));
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { cutoff: { type: "string" }, repos: { type: "string" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help) { console.log("Usage: node scripts/refresh-candidate-ledger.mjs --cutoff YYYY-MM-DD [--repos cutlass,sglang] [--dry-run]"); return 0; }
    if (!values.cutoff) throw new Error("--cutoff is required");
    const cutoff = iso_date(values.cutoff);
    const per_repo = {};
    for (const slug of values.repos ? values.repos.split(",") : Object.keys(REPO_SLUG_TO_FULL)) {
      const repo = REPO_SLUG_TO_FULL[slug];
      if (!repo) { console.error(`WARN: unknown repo slug ${JSON.stringify(slug)}`); continue; }
      const ledger = path.join(CANDIDATES_DIR, `${slug}.yaml`);
      if (!fs.existsSync(ledger)) { console.error(`WARN: no ledger for ${slug} at ${ledger}`); per_repo[slug] = []; continue; }
      const data = parse(fs.readFileSync(ledger, "utf8")) || {};
      const keywords = data.keywords_used || [];
      console.log(`  ${slug}: searching ${repo} with ${keywords.length} keywords...`);
      const rows = await gh_search_prs(repo, keywords, cutoff);
      per_repo[slug] = rows;
      console.log(`    -> ${rows.length} merged PRs found within cutoff window`);
      if (!values["dry-run"]) {
        const added = update_ledger(ledger, cutoff, rows, repo);
        if (added) console.log(`    -> +${added} new rows merged into ledger`);
      }
    }
    if (values["dry-run"]) { console.log("\nDry-run mode; no files written."); return 0; }
    if (fs.existsSync(REFRESH_RESULTS_PATH)) {
      const previous = parse(fs.readFileSync(REFRESH_RESULTS_PATH, "utf8")) || {};
      for (const row of previous.repos || []) if (row.repo_slug && !Object.hasOwn(per_repo, row.repo_slug)) {
        per_repo[row.repo_slug] = (row.pr_numbers_seen || []).map((number) => ({ number, title: "", closedAt: row.last_pr_date_seen || "" }));
      }
    }
    write_cutoff(cutoff); write_search_results(cutoff, per_repo);
    console.log(`\nWrote ${path.relative(REPO_ROOT, REFRESH_CUTOFF_PATH)}\nWrote ${path.relative(REPO_ROOT, REFRESH_RESULTS_PATH)}`);
    return 0;
  } catch (error) { console.error(`ERROR: ${error.message}`); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
