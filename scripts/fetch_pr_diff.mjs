#!/usr/bin/env node
/** Fetch pinned, size-capped PR bundles with atomic replacement and provenance. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseMaintenance as parse } from "./_yaml.mjs";
import { REPO_ROOT, _fnmatch, _is_file, _is_main, _walk_files, dump_sorted } from "./compute_core_prs.mjs";
export { REPO_ROOT };
export const ARTIFACTS = path.join(REPO_ROOT, "artifacts", "prs");
export const CORE_PATH = path.join(REPO_ROOT, "data", "core-prs.yaml");
export const BUDGET_PATH = path.join(REPO_ROOT, "data", "phase3-size-budget.yaml");
export const SOURCES_PRS = path.join(REPO_ROOT, "sources", "prs");
export const FILE_SIZE_CAP = 1024 ** 2;
export const BUNDLE_SIZE_CAP = 5 * 1024 ** 2;
export const KERNEL_EXTS_C = new Set([".cu", ".cuh", ".cpp", ".cxx", ".cc", ".h", ".hpp", ".hxx", ".inl"]);
export const KERNEL_EXTS_PTX = new Set([".ptx"]);
export const KERNEL_EXTS_PY_STRICT = new Set([".py", ".pyx"]);
export const KERNEL_PY_KEYWORDS = ["kernel", "triton", "cute", "ops", "csrc", "attention", "backends"];
export const SKIP_GLOBS = [
  "tests/**", "**/tests/**", "test/**", "**/test/**", "*_test.cu", "*_test.cpp", "*_tests.py", "**/test_*.py", "**/*_test.py", "**/*_tests.py", "**/conftest.py",
  "benchmark/**", "benchmarks/**", "bench/**", "**/benchmark/**", "**/benchmarks/**", "**/bench/**", "**/bench_*.py", "**/*_bench.py", "**/*_benchmark.py",
  "**/examples/**/test_*", "**/examples/**/demo_*", "docs/**", "**/docs/**", "**/README*", "**/CHANGELOG*", "**/release_notes*", "**/LICENSE*", "**/NOTICE*",
  ".github/**", "**/.github/**", "ci/**", "**/ci/**", "**/Makefile", "**/*.mk", "**/CMakeLists.txt", "**/.gitignore",
];
export function run_gh(args, capture = true, { exec = execFileSync } = {}) {
  try { const out = exec("gh", args, { stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"], maxBuffer: 1024 ** 3 }); return capture ? Buffer.from(out) : Buffer.alloc(0); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("gh CLI not found; install https://cli.github.com/");
    throw new Error(`gh ${args.join(" ")} failed: ${Buffer.from(error.stderr || error.message || "").toString().trim()}`);
  }
}
export function load_core_prs(root = REPO_ROOT) {
  const file = path.join(root, "data", "core-prs.yaml");
  if (!_is_file(file)) throw new Error("missing data/core-prs.yaml; run scripts/compute_core_prs.mjs first");
  const data = parse(readFileSync(file, "utf8"));
  return (data.prs || []).filter(e => e && Object.hasOwn(e, "id")).map(e => e.id);
}
function* pr_pages(root) {
  for (const md of _walk_files(path.join(root, "sources", "prs"))) {
    if (!/^PR-.*\.md$/.test(path.basename(md))) continue;
    let text;
    try { text = readFileSync(md, "utf8").replace(/\r\n?/g, "\n"); } catch { continue; }
    const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) continue;
    let fm;
    try { fm = parse(m[1]) || {}; } catch { continue; }
    yield [md, fm, text];
  }
}
export function read_pr_page(pid, root = REPO_ROOT) {
  for (const page of pr_pages(root)) if (page[1].id === pid) return page;
  return [null, null, null];
}
export function _path_skipped(posix) { return SKIP_GLOBS.some(g => _fnmatch(posix, g)); }
export function _suffix(posix) { return posix.split("/").at(-1).includes(".") ? "." + posix.split(".").at(-1).toLowerCase() : ""; }
function allowed(file, relaxed) {
  const posix = file.replaceAll("\\", "/");
  if (_path_skipped(posix)) return false;
  const suffix = _suffix(posix);
  if (KERNEL_EXTS_C.has(suffix) || KERNEL_EXTS_PTX.has(suffix)) return true;
  if (KERNEL_EXTS_PY_STRICT.has(suffix)) return relaxed || KERNEL_PY_KEYWORDS.some(kw => posix.toLowerCase().includes(kw));
  return suffix === ".json" && posix.includes("cutlass_configs");
}
export function path_allowed(file) { return allowed(file, false); }
export function path_allowed_relaxed(file) { return allowed(file, true); }
export function select_captured_files(file_list) {
  const strict = file_list.filter(f => path_allowed(f.filename || ""));
  if (strict.length) return [strict, false];
  const relaxed = file_list.filter(f => path_allowed_relaxed(f.filename || ""));
  return [relaxed, Boolean(relaxed.length)];
}
export async function fetch_content_at_sha(repo, file, sha, options = {}) {
  const gh = options.run_gh || run_gh;
  const data = JSON.parse(await gh(["api", `/repos/${repo}/contents/${file}?ref=${sha}`]));
  if (data.type !== "file") throw new Error(`unexpected response for ${repo}:${file}@${sha.slice(0, 10)}: type=${data.type ?? "None"}`);
  if (data.content) return Buffer.from(data.content, "base64");
  if (data.download_url) {
    try {
      const response = await (options.fetch || fetch)(data.download_url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch { /* The git blob fallback also covers a failed raw download. */ }
  }
  if (data.sha) return Buffer.from(await gh(["api", "-H", "Accept: application/vnd.github.raw", `/repos/${repo}/git/blobs/${data.sha}`]));
  throw new Error(`could not fetch ${repo}:${file}@${sha.slice(0, 10)}: contents response had no \`content\`, no \`download_url\`, and no blob \`sha\``);
}
export async function fetch_pr_file_list(repo, pr_num, { run_gh: gh = run_gh } = {}) {
  const results = [];
  for (let page = 1; page <= 20; page++) {
    const chunk = JSON.parse(await gh(["api", `/repos/${repo}/pulls/${pr_num}/files?per_page=100&page=${page}`]));
    if (!Array.isArray(chunk) || !chunk.length) break;
    results.push(...chunk);
    if (chunk.length < 100) break;
  }
  return results;
}
export async function fetch_pr_whole_diff(repo, pr_num, { run_gh: gh = run_gh } = {}) {
  return Buffer.from(await gh(["pr", "diff", String(pr_num), "-R", repo]));
}
export function sha256_bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
export function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Async I/O; optional dependencies/root let tests use disposable local bundles. */
export async function emit_bundle(repo, pr_num, pr_id, merge_sha, file_list, whole_diff, dry_run = false, options = {}) {
  const root = options.root || REPO_ROOT, log = options.log || console.log;
  const gh = options.run_gh || run_gh, fetch_content = options.fetch_content_at_sha || fetch_content_at_sha;
  const repo_short = repo.split("/").at(-1).toLowerCase();
  const bundle_final = path.join(root, "artifacts", "prs", repo_short, `PR-${pr_num}`);
  const bundle_rel = path.relative(root, bundle_final);
  const [captured_files, used_relaxed] = select_captured_files(file_list);
  if (dry_run) {
    log(`  DRY-RUN ${pr_id}: ${captured_files.length}/${file_list.length} files would be captured${used_relaxed ? " (relaxed-fallback)" : ""}`);
    for (const f of captured_files.slice(0, 20)) log(`    + ${f.filename || ""}`);
    if (captured_files.length > 20) log(`    + ... (${captured_files.length - 20} more)`);
    return [bundle_rel, 0, captured_files.length, false];
  }
  const bundle_work = path.join(path.dirname(bundle_final), `.${path.basename(bundle_final)}.new`);
  mkdirSync(path.dirname(bundle_final), { recursive: true });
  rmSync(bundle_work, { recursive: true, force: true });
  mkdirSync(bundle_work);
  let files_entries = [], bundle_total = 0, bundle_truncated = false;
  try {
    if (whole_diff !== null && whole_diff !== undefined) {
      writeFileSync(path.join(bundle_work, "diff.patch"), whole_diff);
      bundle_total += whole_diff.length;
      files_entries.push({ local_path: "diff.patch", role: "pr-diff", mode: "upstream-patch", sha256: sha256_bytes(whole_diff) });
    }
    let base_sha = null;
    for (const f of captured_files) {
      const filename = f.filename || "", is_removed = f.status === "removed";
      let fetch_sha = merge_sha;
      if (is_removed) {
        if (base_sha === null) {
          try { base_sha = JSON.parse(await gh(["api", `/repos/${repo}/pulls/${pr_num}`])).base?.sha || ""; }
          catch (error) { throw new Error(`could not resolve base SHA for removed files in ${repo}#${pr_num}: ${error.message}. Aborting PR ${pr_id} capture (partial bundles are not committed).`); }
        }
        if (!base_sha) throw new Error(`${repo}#${pr_num} has a removed file (${filename}) but no base SHA resolved; cannot capture pre-deletion content. Aborting PR ${pr_id} capture.`);
        fetch_sha = base_sha;
      }
      let content;
      try { content = Buffer.from(await fetch_content(repo, filename, fetch_sha, options)); }
      catch (error) { throw new Error(`key-file fetch failed for ${repo}:${filename}@${fetch_sha.slice(0, 10)}: ${error.message}. Aborting PR ${pr_id} capture (partial bundles are not committed).`); }
      const local_rel = `key-files/${filename}`, out_path = path.join(bundle_work, local_rel);
      // Upstream names are POSIX relative paths; never allow a remote path to escape staging.
      const inside = path.relative(path.join(bundle_work, "key-files"), out_path);
      if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(filename)) throw new Error(`invalid upstream file path: ${filename}`);
      const truncated = content.length > FILE_SIZE_CAP;
      if (truncated) content = Buffer.from(`/* size_cap_truncated: upstream file is ${content.length} bytes (> ${FILE_SIZE_CAP}). Re-fetch upstream at ${repo}:${filename}@${fetch_sha} to read the full content. */\n`);
      mkdirSync(path.dirname(out_path), { recursive: true });
      writeFileSync(out_path, content);
      bundle_total += content.length;
      const entry = { local_path: local_rel, role: "upstream-file", mode: "verbatim", upstream_path: filename, sha256: sha256_bytes(content) };
      if (is_removed) {
        entry.upstream_sha = fetch_sha;
        entry.captured_at_base_sha_note = `PR #${pr_num} deletes this file. Captured verbatim at the PR's base SHA (pre-merge) so users can inspect the pre-deletion state.`;
      }
      if (truncated) entry.size_cap_truncated = true;
      files_entries.push(entry);
    }
    const diff_path = path.join(bundle_work, "diff.patch");
    if (bundle_total > BUNDLE_SIZE_CAP && _is_file(diff_path)) {
      bundle_total -= statSync(diff_path).size;
      unlinkSync(diff_path);
      files_entries = files_entries.filter(e => e.local_path !== "diff.patch");
      bundle_truncated = true;
    }
    if (bundle_total > BUNDLE_SIZE_CAP) {
      const candidates = files_entries.filter(e => e.local_path.startsWith("key-files/")).map(e => [e, statSync(path.join(bundle_work, e.local_path)).size]).filter(([, size]) => size > 0).sort((a, b) => b[1] - a[1]);
      for (const [entry, original_size] of candidates) {
        if (bundle_total <= BUNDLE_SIZE_CAP) break;
        const stub = Buffer.from(`/* bundle_cap_truncated: upstream file fits the per-file cap but the aggregate bundle size exceeds ${BUNDLE_SIZE_CAP} bytes. Re-fetch upstream at ${repo}:${entry.upstream_path}@${entry.upstream_sha || merge_sha} to read the full content. */\n`);
        writeFileSync(path.join(bundle_work, entry.local_path), stub);
        entry.sha256 = sha256_bytes(stub); entry.size_cap_truncated = true;
        bundle_total += stub.length - original_size; bundle_truncated = true;
      }
    }
    const prov = {
      origin_url: `https://github.com/${repo}/pull/${pr_num}`, upstream_repo: repo, upstream_sha: merge_sha,
      license: "inherits-from-upstream", retrieved_at: (options.today || _today)(), asset_mode: "verbatim",
      size_cap_truncated: bundle_truncated, generated_by: "scripts/fetch_pr_diff.mjs", source_pr_id: pr_id, files: files_entries,
    };
    if (used_relaxed) prov.captured_via_relaxed_allowlist = true;
    writeFileSync(path.join(bundle_work, "PROVENANCE.yaml"), dump_sorted(prov), "utf8");
  } catch (error) { rmSync(bundle_work, { recursive: true, force: true }); throw error; }
  let bundle_prev = null;
  if (existsSync(bundle_final)) {
    bundle_prev = path.join(path.dirname(bundle_final), `.${path.basename(bundle_final)}.prev`);
    rmSync(bundle_prev, { recursive: true, force: true });
    renameSync(bundle_final, bundle_prev);
  }
  try { renameSync(bundle_work, bundle_final); }
  catch (error) {
    if (bundle_prev && existsSync(bundle_prev)) { try { renameSync(bundle_prev, bundle_final); } catch { /* best effort */ } }
    throw new Error(`atomic bundle swap failed for ${bundle_rel}: ${error.message}; prior bundle restored if possible, staging dir retained at ${bundle_work}`);
  }
  if (bundle_prev && existsSync(bundle_prev)) rmSync(bundle_prev, { recursive: true, force: true });
  return [bundle_rel, bundle_total, files_entries.length, bundle_truncated];
}
export function update_pr_page(md_path, original_text, bundle_rel) {
  const m = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*\r?\n)([\s\S]*)/.exec(original_text);
  if (!m) return false;
  let fm;
  try { fm = parse(m[2]) || {}; } catch { return false; }
  fm.artifact_dir = String(bundle_rel);
  for (const banned of ["diff_path", "code_path", "patch_path", "key_file_path"]) delete fm[banned];
  writeFileSync(md_path, m[1] + dump_sorted(fm).trimEnd() + m[3] + m[4], "utf8");
  return true;
}
export function select_pilot_ids(all_ids, all_prs_by_id) {
  const buckets = new Map();
  for (const pid of all_ids) {
    const fm = all_prs_by_id instanceof Map ? all_prs_by_id.get(pid) : all_prs_by_id[pid];
    if (!fm) continue;
    const repo = (fm.repo || "").split("/").at(-1).toLowerCase();
    if (!buckets.has(repo)) buckets.set(repo, []);
    buckets.get(repo).push(pid);
  }
  const pilot = ["cutlass", "sglang", "vllm", "flashinfer", "pytorch"].flatMap(repo => (buckets.get(repo) || []).slice(0, 4));
  for (const pid of all_ids) { if (pilot.length >= 20) break; if (!pilot.includes(pid)) pilot.push(pid); }
  return pilot.slice(0, 20);
}
function cli_args(argv) {
  const args = { pilot: false, all: false, ids: null, dry_run: false, dry_run_live: false, max_pr: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i], eq = token.indexOf("="), flag = eq < 0 ? token : token.slice(0, eq), value = eq < 0 ? null : token.slice(eq + 1);
    const key = { "--pilot": "pilot", "--all": "all", "--dry-run": "dry_run", "--dry-run-live": "dry_run_live", "--help": "help", "-h": "help" }[flag];
    if (key) { if (value !== null) throw new Error(`${flag} does not take a value`); args[key] = true; }
    else if (flag === "--ids") {
      const ids = value !== null ? [value] : [];
      if (value === null) while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) ids.push(argv[++i]);
      if (!ids.length) throw new Error("--ids requires at least one PR_ID");
      args.ids = ids;
    } else if (flag === "--max-pr") {
      const n = value ?? argv[++i];
      if (!n || !/^[+-]?\d+$/.test(n) || !Number.isSafeInteger(Number(n))) throw new Error("--max-pr requires an integer");
      args.max_pr = Number(n);
    } else throw new Error(`unrecognized argument: ${token}`);
  }
  return args;
}
export async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log, warn = options.warn || console.error;
  try {
    const args = cli_args(argv), root = options.root || REPO_ROOT;
    if (args.help) { log("Usage: fetch_pr_diff.mjs [--pilot | --all | --ids PR_ID ...] [--dry-run] [--dry-run-live] [--max-pr N]\nFetch cleaned, pinned PR bundles; --pilot also writes the size budget."); return 0; }
    const core_ids = load_core_prs(root), all_prs_by_id = {};
    for (const [, fm] of pr_pages(root)) if (fm.id) all_prs_by_id[fm.id] = fm;
    let targets;
    if (args.ids) targets = args.ids;
    else if (args.pilot) { targets = select_pilot_ids(core_ids, all_prs_by_id); log(`Pilot set: ${targets.length} PRs`); }
    else if (args.all) targets = [...core_ids];
    else throw new Error("must pass --pilot, --all, or --ids");
    if (args.max_pr) targets = targets.slice(0, args.max_pr);
    let ok = 0;
    const pilot_stats = [], emit = options.emit_bundle || emit_bundle, list_files = options.fetch_pr_file_list || fetch_pr_file_list;
    for (const [i, pid] of targets.entries()) {
      const fm = all_prs_by_id[pid];
      if (!fm) { log(`  SKIP ${pid}: no source page found`); continue; }
      const { repo, pr: pr_num, merge_sha } = fm;
      if (!(repo && pr_num && merge_sha)) { log(`  SKIP ${pid}: missing repo/pr/merge_sha in source page`); continue; }
      log(`[${i + 1}/${targets.length}] ${pid}  (${repo}#${pr_num} @ ${merge_sha.slice(0, 10)})`);
      let file_list;
      if (args.dry_run && !args.dry_run_live) {
        const stored_paths = fm.changed_paths || [];
        if (!stored_paths.length) { log(`    DRY-RUN ${pid}: source page has no changed_paths; use --dry-run-live to preview from the real PR file list`); ok++; continue; }
        await emit(repo, pr_num, pid, merge_sha, stored_paths.map(filename => ({ filename })), null, true, options); ok++; continue;
      }
      try { file_list = await list_files(repo, pr_num, options); }
      catch (error) { warn(`    WARN: file-list fetch failed: ${error.message}`); continue; }
      if (args.dry_run_live) { await emit(repo, pr_num, pid, merge_sha, file_list, null, true, options); ok++; continue; }
      let whole_diff;
      try { whole_diff = await (options.fetch_pr_whole_diff || fetch_pr_whole_diff)(repo, pr_num, options); }
      catch (error) { warn(`    WARN: diff fetch failed: ${error.message}; continuing without diff.patch`); whole_diff = null; }
      let result;
      try { result = await emit(repo, pr_num, pid, merge_sha, file_list, whole_diff, false, options); }
      catch (error) { warn(`    ERROR: bundle emission failed: ${error.message}`); continue; }
      const [bundle_rel, total, nfiles, truncated] = result;
      log(`    -> ${bundle_rel} (${nfiles} files, ${(total / 1024).toFixed(1)} KiB, truncated=${truncated ? "True" : "False"})`);
      const [md_path, , original_text] = read_pr_page(pid, root);
      if (md_path) update_pr_page(md_path, original_text, bundle_rel);
      ok++;
      pilot_stats.push({ pr_id: pid, repo, pr_number: pr_num, bundle_bytes: total, num_files: nfiles, truncated });
    }
    log(`\nFetched ${ok}/${targets.length} PRs successfully.`);
    const partial_failure = ok !== targets.length;
    if (args.pilot && pilot_stats.length && !partial_failure) {
      const total_bytes = pilot_stats.reduce((n, s) => n + s.bundle_bytes, 0), avg_bundle = total_bytes / pilot_stats.length;
      const proj_lower = Math.trunc(avg_bundle * Math.min(80, core_ids.length) * 1.25), proj_upper = Math.trunc(avg_bundle * 460 * 1.25);
      const budget = {
        generated_by: "scripts/fetch_pr_diff.mjs --pilot", pilot_size: pilot_stats.length, pilot_total_bytes: total_bytes, avg_bundle_bytes: Math.trunc(avg_bundle), core_prs_total: core_ids.length,
        lower_bound_projection_mib: Number((proj_lower / 1024 ** 2).toFixed(2)), upper_bound_projection_mib: Number((proj_upper / 1024 ** 2).toFixed(2)),
        active_ceiling_mib: proj_lower < 25 * 1024 ** 2 ? 25 : proj_upper < 60 * 1024 ** 2 ? 60 : Math.floor(proj_upper / 1024 ** 2) + 10, pilot_entries: pilot_stats,
      };
      writeFileSync(path.join(root, "data", "phase3-size-budget.yaml"), dump_sorted(budget), "utf8");
      log(`\nWrote data/phase3-size-budget.yaml\n  Avg bundle: ${(avg_bundle / 1024).toFixed(1)} KiB\n  Lower-bound projection: ${budget.lower_bound_projection_mib} MiB\n  Upper-bound projection: ${budget.upper_bound_projection_mib} MiB\n  Active ceiling: ${budget.active_ceiling_mib} MiB`);
    } else if (args.pilot && partial_failure) warn(`\nSkipping data/phase3-size-budget.yaml write: pilot fetch was partial (${ok}/${targets.length}). Re-run after resolving the gh / upstream issue.`);
    if (partial_failure) { warn(`\nERROR: ${targets.length - ok} of ${targets.length} requested PR(s) did not fetch successfully. See the per-PR WARN / ERROR lines above.`); return 1; }
    return 0;
  } catch (error) { warn(`ERROR: ${error.message}`); return 2; }
}
if (_is_main(import.meta.url)) process.exitCode = await main();
