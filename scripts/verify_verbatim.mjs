#!/usr/bin/env node
/** Verify verbatim / upstream-patch assets; exit 2 means an inconclusive environment failure. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseMaintenance as parse } from "./_yaml.mjs";
import { REPO_ROOT, _is_main, _is_file, _walk_files } from "./compute_core_prs.mjs";
export { REPO_ROOT };
export const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
export const _PATCH_INDEX_RE = /^(index )[0-9a-fA-F]+(\.\.)[0-9a-fA-F]+([^\n]*)$/gm;
export function canonicalize_upstream_patch(data) {
  return Buffer.from(Buffer.from(data).toString("latin1").replace(_PATCH_INDEX_RE, "$1<OLD>$2<NEW>$3"), "latin1");
}
export class EnvError extends Error {}
export const _ENV_ERROR_HINTS = [
  "could not resolve host", "no such host", "temporary failure in name resolution", "unable to resolve",
  "connection refused", "connection reset", "connection timed out", "network is unreachable", "no route to host", "dial tcp", "i/o timeout", "context deadline exceeded", "request timed out",
  "error connecting", "failed to connect", "unable to connect", "couldn't connect", "cannot reach", "can't reach",
  "x509:", "tls handshake", "certificate signed by unknown authority", "certificate has expired", "self signed certificate",
  "proxy error", "proxyconnect", "authentication required", "you must authenticate", "you are not logged in", "not logged into", "bad credentials", "token expired", "sso enforcement",
  "rate limit", "api rate limit exceeded", "abuse detection", "secondary rate limit",
  "gh auth login", "http 401",
];
export function _looks_like_env_error(stderr_text) {
  const low = stderr_text.toLowerCase();
  return _ENV_ERROR_HINTS.some(h => low.includes(h));
}
export function run_gh(args, { exec = execFileSync } = {}) {
  try { return Buffer.from(exec("gh", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 ** 3 })); }
  catch (error) {
    if (error.code === "ENOENT") throw new EnvError("gh CLI not found; install from https://cli.github.com/");
    const stderr = Buffer.from(error.stderr || error.message || "").toString("utf8");
    if (_looks_like_env_error(stderr)) throw new EnvError(`gh ${args.join(" ")} environment failure: ${stderr.trim().slice(0, 200)}`);
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim().slice(0, 200)}`);
  }
}
export async function fetch_verbatim(upstream_repo, upstream_sha, upstream_path, { run_gh: gh = run_gh } = {}) {
  const endpoint = `/repos/${upstream_repo}/contents/${upstream_path}?ref=${upstream_sha}`;
  const data = JSON.parse(await gh(["api", endpoint]));
  if (!Object.hasOwn(data, "content")) throw new Error(`no content in response for ${upstream_repo}:${upstream_path}@${upstream_sha}`);
  return Buffer.from(data.content, "base64");
}
export async function fetch_upstream_patch(upstream_repo, pr_number, expected_sha = null, { run_gh: gh = run_gh } = {}) {
  if (expected_sha) {
    const pr_data = JSON.parse(await gh(["api", `/repos/${upstream_repo}/pulls/${pr_number}`]));
    const merge_sha = pr_data.merge_commit_sha || "";
    if (!(merge_sha && merge_sha.startsWith(expected_sha))) {
      const head_sha = pr_data.head?.sha || "";
      throw new Error(`upstream_sha '${expected_sha}' does not prefix-match merge_commit_sha=${merge_sha.slice(0, 12)}... (head.sha=${head_sha.slice(0, 12)}... shown for reference; not accepted) for ${upstream_repo}#${pr_number}; the PR was amended upstream`);
    }
  }
  return Buffer.from(await gh(["pr", "diff", String(pr_number), "-R", upstream_repo]));
}
export const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;
export const PR_ID_RE = /^pr-[a-z0-9\-]+-(\d+)$(?![\s\S])/;
export const PR_FILENAME_RE = /PR[_-](\d+)/i;
export const PR_DIR_RE = /^PR-(\d+)$(?![\s\S])/;
export function _resolve_pr_number(bundle_root, prov, local_path) {
  return PR_DIR_RE.exec(path.basename(bundle_root))?.[1] || PR_ID_RE.exec(prov?.source_pr_id || "")?.[1] || PR_URL_RE.exec(prov?.origin_url || "")?.[1] || PR_FILENAME_RE.exec(local_path)?.[1] || null;
}
export function* iter_bundles(scope, root = REPO_ROOT) {
  if (scope) { yield path.resolve(scope); return; }
  for (const prov of _walk_files(path.join(root, "artifacts"))) if (path.basename(prov) === "PROVENANCE.yaml") yield path.dirname(prov);
}
export function _rel_to_repo(p, root = REPO_ROOT) {
  const rel = path.relative(root, path.resolve(p));
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? String(p) : rel;
}
export async function verify_bundle(bundle_root, options = {}) {
  const root = options.root || REPO_ROOT;
  const rel = p => _rel_to_repo(p, root);
  const prov_path = path.join(bundle_root, "PROVENANCE.yaml");
  if (!_is_file(prov_path)) return [[`${rel(bundle_root)}: missing PROVENANCE.yaml`], []];
  let prov;
  try { prov = parse(readFileSync(prov_path, "utf8")) || {}; }
  catch (error) {
    if (typeof error.errno === "number") throw new EnvError(`${rel(prov_path)}: ${error.message}`);
    return [[`${rel(prov_path)}: YAML parse error: ${error.message}`], []];
  }
  const errors = [], env_errors = [];
  for (const entry of prov.files || []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const mode = entry.mode;
    if (!["verbatim", "upstream-patch"].includes(mode) || entry.size_cap_truncated) continue;
    const lp = entry.local_path;
    if (!lp) continue;
    const local_path = path.join(bundle_root, lp);
    const label = `${rel(bundle_root)}/${lp}`;
    if (!_is_file(local_path)) { errors.push(`${label}: local file missing`); continue; }
    const local_bytes = readFileSync(local_path);
    const file_upstream_repo = entry.upstream_repo || prov.upstream_repo;
    const file_upstream_sha = entry.upstream_sha || prov.upstream_sha;
    let upstream_bytes;
    try {
      if (mode === "verbatim") {
        if (!(file_upstream_repo && file_upstream_sha && entry.upstream_path)) { errors.push(`${label}: verbatim mode requires upstream_repo + upstream_sha + upstream_path`); continue; }
        upstream_bytes = await (options.fetch_verbatim || fetch_verbatim)(file_upstream_repo, file_upstream_sha, entry.upstream_path, options);
      } else {
        const pr_num = _resolve_pr_number(bundle_root, prov, lp);
        if (!pr_num) { errors.push(`${label}: upstream-patch mode could not resolve a PR number from source_pr_id, origin_url, patch filename, or bundle directory name`); continue; }
        if (!file_upstream_sha) { errors.push(`${label}: upstream-patch mode requires upstream_sha (bundle-level or per-file) to pin the verification to the exact upstream state`); continue; }
        upstream_bytes = await (options.fetch_upstream_patch || fetch_upstream_patch)(file_upstream_repo, pr_num, file_upstream_sha, options);
      }
    } catch (error) {
      if (error instanceof EnvError) env_errors.push(`${label}: environment failure: ${error.message}`);
      else errors.push(`${label}: upstream fetch failed: ${error.message}`);
      continue;
    }
    const comparable_local = mode === "upstream-patch" ? canonicalize_upstream_patch(local_bytes) : local_bytes;
    const comparable_upstream = mode === "upstream-patch" ? canonicalize_upstream_patch(upstream_bytes) : Buffer.from(upstream_bytes);
    if (!comparable_local.equals(comparable_upstream)) {
      const sha = bytes => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      errors.push(`${label}: ${mode === "upstream-patch" ? "canonicalized upstream-patch" : mode} mismatch (local ${sha(local_bytes)}..., upstream ${sha(upstream_bytes)}...)`);
    }
  }
  return [errors, env_errors];
}
export async function main(argv = process.argv.slice(2), options = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { strict: { type: "boolean" }, bundle: { type: "string" }, help: { type: "boolean", short: "h" } } });
    if (values.help) { console.log("Usage: verify_verbatim.mjs [--strict] [--bundle DIR]\nVerify verbatim and upstream-patch bytes against upstream (default: warn-only)."); return 0; }
    const root = options.root || REPO_ROOT;
    try { if (!statSync(path.join(root, "artifacts")).isDirectory()) throw new Error(); }
    catch { console.log("No artifacts/ directory; nothing to verify."); return 0; }
    const errors = [], env_errors = [];
    let checked = 0;
    for (const bundle of iter_bundles(values.bundle, root)) {
      checked++;
      const [errs, env_errs] = await (options.verify_bundle || verify_bundle)(bundle, options);
      errors.push(...errs); env_errors.push(...env_errs);
    }
    console.log(`Verified ${checked} bundle(s).`);
    for (const e of env_errors) console.error(`  ENV: ${e}`);
    if (env_errors.length) console.error(`\n${env_errors.length} environment failure(s).`);
    for (const e of errors) console.error(`  WARN: ${e}`);
    if (errors.length) console.error(`\n${errors.length} mismatch(es) found.`);
    if (env_errors.length) return 2;
    if (errors.length) return values.strict ? 1 : 0;
    console.log("All verbatim/upstream-patch assets match upstream.");
    return 0;
  } catch (error) { console.error(`ERROR: ${error.message}`); return 2; }
}
if (_is_main(import.meta.url)) process.exitCode = await main();
