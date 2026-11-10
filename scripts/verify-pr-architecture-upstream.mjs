#!/usr/bin/env node
/** Re-derive deterministic high-risk PR samples from live, complete GitHub evidence. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parseMaintenance as parse } from "./lib/yaml.mjs";
import { REPO_ROOT, _is_file, _is_main } from "./compute-core-prs.mjs";
import { EnvError, run_gh } from "./verify-verbatim.mjs";
import {
  _path_is_distributed_implementation, _path_is_non_implementation, classify_scope,
  cuda_translation_unit_device_signal, device_code_pattern_sha256, derive_architectures,
  derive_metadata, cuda_requires_complete_evidence, python_dsl_languages,
  python_dsl_pattern_sha256, python_requires_complete_evidence, parse_git_diff_files,
  upstream_files_sha256,
} from "./lib/pr-policy.mjs";
export const ROOT = REPO_ROOT;
export const SAMPLES = [
  ["tilelang/PR-2198.md", "tile-ai/tilelang", 2198],
  ["vllm/PR-29901.md", "vllm-project/vllm", 29901],
  ["flashinfer/PR-1503.md", "flashinfer-ai/flashinfer", 1503],
  ["cutlass/PR-2995.md", "NVIDIA/cutlass", 2995],
  ["TensorRT-LLM/PR-10987.md", "NVIDIA/TensorRT-LLM", 10987],
  ["TensorRT-LLM/PR-12937.md", "NVIDIA/TensorRT-LLM", 12937],
  ["TensorRT-LLM/PR-12612.md", "NVIDIA/TensorRT-LLM", 12612],
  ["TensorRT-LLM/PR-13652.md", "NVIDIA/TensorRT-LLM", 13652],
  ["TensorRT-LLM/PR-12470.md", "NVIDIA/TensorRT-LLM", 12470],
  ["TensorRT-LLM/PR-13505.md", "NVIDIA/TensorRT-LLM", 13505],
  ["TensorRT-LLM/PR-14291.md", "NVIDIA/TensorRT-LLM", 14291],
  ["vllm/PR-15354.md", "vllm-project/vllm", 15354],
  ["flashinfer/PR-958.md", "flashinfer-ai/flashinfer", 958],
  ["flashinfer/PR-994.md", "flashinfer-ai/flashinfer", 994],
  ["DeepGEMM/PR-83.md", "deepseek-ai/DeepGEMM", 83],
  ["sglang/PR-3033.md", "sgl-project/sglang", 3033],
  ["flashinfer/PR-1398.md", "flashinfer-ai/flashinfer", 1398],
  ["sglang/PR-6101.md", "sgl-project/sglang", 6101],
  ["flashinfer/PR-1389.md", "flashinfer-ai/flashinfer", 1389],
];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function frontmatter(file) {
  const text = readFileSync(file, "utf8");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/.exec(text);
  if (!match) throw new Error(`missing frontmatter: ${file}`);
  return parse(match[1]) || {};
}
export async function github_json(endpoint, { run_gh: gh = run_gh } = {}) {
  return JSON.parse(await gh(["api", endpoint]));
}
export async function _fetch_bytes(url, { fetch: fetch_url = fetch } = {}) {
  let response;
  try { response = await fetch_url(url, { headers: { "User-Agent": "KernelWiki-factual-audit" }, signal: AbortSignal.timeout(120_000) }); }
  catch (error) { throw new EnvError(`fetch ${url} environment failure: ${error.message}`); }
  if (!response.ok) {
    const message = `fetch ${url} failed: HTTP ${response.status}`;
    if ([401, 403, 408, 429].includes(response.status) || response.status >= 500) throw new EnvError(message);
    throw new Error(message);
  }
  try { return Buffer.from(await response.arrayBuffer()); }
  catch (error) { throw new EnvError(`fetch ${url} environment failure: ${error.message}`); }
}
export async function fetch_full_diff_files(repo, pr, options = {}) {
  const content = await (options._fetch_bytes || _fetch_bytes)(`https://github.com/${repo}/pull/${pr}.diff`, options);
  return parse_git_diff_files(Buffer.from(content).toString("utf8"));
}
export async function attach_complete_file_evidence(repo, head_sha, files, options = {}) {
  const candidates = [];
  for (const item of files) {
    const file = item.filename || item.path || "";
    if (_path_is_non_implementation(file) || _path_is_distributed_implementation(file)) continue;
    const kind = cuda_requires_complete_evidence(item) ? "cuda" : python_requires_complete_evidence(item) ? "python-dsl" : null;
    if (!kind) continue;
    // encodeURIComponent additionally escapes the five punctuation characters urllib.quote escapes.
    const encoded = file.split("/").map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
    candidates.push([item, `https://raw.githubusercontent.com/${repo}/${head_sha}/${encoded}`, kind]);
  }
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const [item, url, kind] = candidates[cursor++];
      const content = Buffer.from(await (options._fetch_bytes || _fetch_bytes)(url, options));
      const text = content.toString("utf8");
      if (kind === "cuda") Object.assign(item, {
        complete_file_evidence_complete: true, complete_file_sha256: sha256(content),
        complete_file_device_signal: cuda_translation_unit_device_signal(text),
        complete_file_device_pattern_sha256: device_code_pattern_sha256(),
      });
      else {
        const languages = [...python_dsl_languages(text)];
        Object.assign(item, {
          complete_file_python_dsl_evidence_complete: true, complete_file_python_dsl_sha256: sha256(content),
          complete_file_python_dsl_signal: Boolean(languages.length), complete_file_python_dsl_languages: languages,
          complete_file_python_dsl_pattern_sha256: python_dsl_pattern_sha256(),
        });
      }
    }
  }
  // Wait for all workers even on failure, matching the executor's shutdown contract.
  const results = await Promise.allSettled(Array.from({ length: Math.min(16, candidates.length) }, worker));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return files;
}
export async function attach_complete_cuda_evidence(repo, head_sha, files, options = {}) {
  return attach_complete_file_evidence(repo, head_sha, files, options);
}
export async function fetch_upstream(repo, pr, options = {}) {
  const get = options.github_json || github_json;
  const pull = await get(`repos/${repo}/pulls/${pr}`, options);
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await get(`repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`, options);
    if (!Array.isArray(batch)) throw new Error(`${repo}#${pr}: GitHub files response is not a list`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const expected_count = Number(pull.changed_files || 0), listing_complete = files.length === expected_count;
  if (!listing_complete && !(expected_count > 3000 && files.length === 3000)) throw new Error(`${repo}#${pr}: incomplete GitHub file pagination: expected ${expected_count}, received ${files.length}`);
  let evidence_files = files;
  if (!listing_complete) {
    evidence_files = await (options.fetch_full_diff_files || fetch_full_diff_files)(repo, pr, options);
    if (evidence_files.length !== expected_count) throw new Error(`${repo}#${pr}: full pull diff count mismatch: expected ${expected_count}, received ${evidence_files.length}`);
  }
  if (evidence_files.some(item => cuda_requires_complete_evidence(item) || python_requires_complete_evidence(item))) {
    const head = pull.head?.sha;
    if (typeof head !== "string" || !/^[0-9a-f]{40,64}$(?![\s\S])/.test(head)) throw new Error(`${repo}#${pr}: missing immutable pull head SHA`);
    await (options.attach_complete_file_evidence || attach_complete_file_evidence)(repo, head, evidence_files, options);
  }
  return [pull, files, listing_complete, evidence_files];
}
export function derive_upstream_record(pull, files, listing_complete = null, evidence_files = null) {
  const title = pull.title || "", body = pull.body || "";
  evidence_files ??= files;
  const scope = classify_scope(title, body, evidence_files);
  const [architectures, disposition, evidence] = derive_architectures(title, body, evidence_files);
  const metadata = derive_metadata(title, body, evidence_files, scope);
  const total = Number(pull.changed_files || files.length);
  listing_complete ??= files.length === total;
  const all_paths = evidence_files.map(item => item.filename), evidence_paths = [...scope.evidence_paths];
  for (const row of evidence) {
    const locator = row.locator || "";
    if (locator.startsWith("changed-path:")) evidence_paths.push(locator.slice("changed-path:".length));
    else if (locator.startsWith("added-patch:")) evidence_paths.push(locator.slice("added-patch:".length));
  }
  const display_paths = [...new Set([...all_paths.slice(0, 25), ...evidence_paths])];
  const result = {
    title, retain: scope.retain, scope_rule: scope.rule, scope_paths: [...scope.evidence_paths],
    architectures, architecture_disposition: disposition, architecture_evidence: evidence, metadata,
    upstream_body_sha256: sha256(Buffer.from(body)), upstream_files_sha256: upstream_files_sha256(evidence_files),
    changed_files_count: total, changed_files_enumerated_count: files.length, changed_files_listing_complete: listing_complete,
    changed_paths: display_paths, changed_paths_complete: listing_complete && display_paths.length === total,
  };
  if (evidence_files !== files) Object.assign(result, {
    changed_files_evidence_count: evidence_files.length, changed_files_evidence_complete: evidence_files.length === total,
    changed_files_evidence_method: "github-pull-diff", changed_files_evidence_receipt: "audit/pr-file-cap-reconstruction.json", scope_path_source: "github-pull-diff",
  });
  return result;
}
export function compare_local_page(label, fm, expected) {
  if (!expected.retain) return fm !== null && fm !== undefined ? [`${label}: upstream policy removes PR but local page exists`] : [];
  if (fm === null || fm === undefined) return [`${label}: upstream policy retains PR but local page is missing`];
  const comparisons = Object.fromEntries(["title", "architectures", "architecture_disposition", "architecture_evidence", "upstream_body_sha256", "upstream_files_sha256", "changed_files_count", "changed_paths", "changed_paths_complete"].map(field => [field, expected[field]]));
  comparisons.scope_disposition = "retained";
  if (!expected.changed_files_listing_complete || Object.hasOwn(fm, "changed_files_enumerated_count") || Object.hasOwn(fm, "changed_files_listing_complete")) {
    comparisons.changed_files_enumerated_count = expected.changed_files_enumerated_count;
    comparisons.changed_files_listing_complete = expected.changed_files_listing_complete;
  }
  if (Object.hasOwn(expected, "changed_files_evidence_count")) for (const field of ["changed_files_evidence_count", "changed_files_evidence_complete", "changed_files_evidence_method", "changed_files_evidence_receipt"]) comparisons[field] = expected[field];
  const errors = [];
  // Missing and YAML null both correspond to Python dict.get's None.
  const equal = (a, b) => isDeepStrictEqual(a ?? null, b ?? null);
  for (const [field, value] of Object.entries(comparisons)) if (!equal(fm[field], value)) errors.push(`${label}: live-upstream mismatch in ${field}`);
  const scope_evidence = fm.scope_evidence || {};
  for (const [field, value] of [["rule", expected.scope_rule], ["paths", expected.scope_paths], ["path_source", expected.scope_path_source]]) if (!equal(scope_evidence[field], value)) errors.push(`${label}: live-upstream mismatch in scope_evidence.${field}`);
  for (const field of ["tags", "hardware_features", "kernel_types", "techniques", "languages"]) if (!equal(fm[field], expected.metadata[field])) errors.push(`${label}: live-upstream mismatch in ${field}`);
  return errors;
}
export async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log, warn = options.warn || console.error;
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" } } });
    if (values.help) { log("Usage: verify-pr-architecture-upstream.mjs\nVerify 19 deterministic PR samples against live GitHub evidence."); return 0; }
    const errors = [], env_errors = [], samples = options.samples || SAMPLES, root = options.root || ROOT;
    for (const [relative, repo, pr] of samples) {
      const label = `${repo}#${pr}`, page = path.join(root, "sources", "prs", relative);
      try {
        const [pull, files, listing_complete, evidence_files] = await (options.fetch_upstream || fetch_upstream)(repo, pr, options);
        const expected = derive_upstream_record(pull, files, listing_complete, evidence_files);
        const fm = _is_file(page) ? frontmatter(page) : null;
        errors.push(...compare_local_page(label, fm, expected));
        const suffix = listing_complete ? "" : ` (${files.length}/${expected.changed_files_count} API-listed; ${evidence_files.length} full-diff paths)`;
        log(`checked ${label}: ${expected.retain ? "retained" : "removed"}${suffix}`);
      } catch (error) {
        if (error instanceof EnvError || typeof error.errno === "number") env_errors.push(`${label}: ${error.message}`);
        else errors.push(`${label}: ${error.message}`);
      }
    }
    for (const error of errors) warn(`FAIL: ${error}`);
    for (const error of env_errors) warn(`ENV: ${error}`);
    if (env_errors.length) return 2;
    if (errors.length) return 1;
    log(`Verified ${samples.length} deterministic PR samples against live GitHub evidence.`);
    return 0;
  } catch (error) { warn(`ERROR: ${error.message}`); return 2; }
}
if (_is_main(import.meta.url)) process.exitCode = await main();
