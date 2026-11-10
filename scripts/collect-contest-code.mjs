#!/usr/bin/env node
/** Collect author-published contest code, preserving the installed bundle on failure. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parseMaintenance as parse, stringifyMaintenance as stringify } from "./lib/yaml.mjs";

const configured_root = process.env.BLACKWELL_WIKI_ROOT;
export const REPO = configured_root
  ? path.resolve(configured_root === "~" ? os.homedir() : configured_root.replace(/^~\//, `${os.homedir()}/`))
  : path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const CONTESTS_SRC = path.join(REPO, "sources", "contests");
export const CONTESTS_ART = path.join(REPO, "artifacts", "contests");
export const MANIFEST = path.join(REPO, "data", "contest-sources.yaml");
const GENERATED_BY = "scripts/collect_contest_code.py";
const is_file = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const is_dir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => fs.existsSync(p);
const mapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const py_str = (v) => v == null ? "None" : String(v);
const remove_tree = (p) => fs.rmSync(p, { recursive: true, force: true });
const ignore_remove = (p) => { try { remove_tree(p); } catch { /* Best-effort scratch cleanup. */ } };
class BundleSwapError extends Error {}

export function sha256_of(file_path) {
  return createHash("sha256").update(fs.readFileSync(file_path)).digest("hex");
}

export function run_gh(args) {
  const result = spawnSync("gh", args, { maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`gh exited with status ${result.status}`);
    error.name = "CalledProcessError";
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

export function rank_author_slug(rank, participant) {
  const slug = participant.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "anon";
  return `rank-${py_str(rank)}-${slug}`;
}

export function load_md(file_path) {
  const text = fs.readFileSync(file_path, "utf8").replace(/\r\n?/g, "\n");
  const match = /^(---\s*\n)(.*?)(\n---\s*\n)(.*)/s.exec(text);
  if (!match) return null;
  return [match, parse(match[2]) || {}, text];
}

export function save_md(file_path, original_match, fm) {
  const new_fm = stringify(fm, { lineWidth: 0 }).trimEnd();
  fs.writeFileSync(file_path, original_match[1] + new_fm + original_match[3] + original_match[4], "utf8");
}

export function load_manifest() {
  return is_file(MANIFEST) ? parse(fs.readFileSync(MANIFEST, "utf8")) || {} : {};
}

export function _resolve_canonical_file(entry, files_list) {
  const declared = mapping(entry) ? entry.canonical_file : null;
  if (declared) return files_list.some((file) => file.local_path === declared) ? declared : null;
  return files_list.length ? files_list.at(-1).local_path ?? null : null;
}

function decode_content(content) {
  if (typeof content !== "string") throw new TypeError("GitHub file content must be a base64 string");
  const cleaned = content.replace(/[^A-Za-z0-9+/=]/g, "");
  const data = cleaned.split("=", 1)[0];
  const remainder = data.length % 4;
  const padding = cleaned.slice(data.length).match(/^=*/)[0].length;
  if (remainder === 1 || (remainder && padding < 4 - remainder)) throw new TypeError("Incorrect base64 padding");
  return Buffer.from(cleaned, "base64");
}

export function collect_one(contest_page, sub_idx, sub, manifest, contest_page_id = null) {
  const contest_slug = path.basename(path.dirname(contest_page));
  const problem_slug = path.basename(contest_page, path.extname(contest_page));
  const ra_slug = rank_author_slug(sub.rank, sub.participant || "anon");
  const bundle_final = path.join(CONTESTS_ART, contest_slug, problem_slug, "submissions", ra_slug);
  const entry = manifest[contest_slug]?.[problem_slug]?.[ra_slug];
  const new_sub = { ...sub };
  if (!entry || (mapping(entry) && !Object.keys(entry).length)) {
    if (is_dir(bundle_final)) {
      remove_tree(bundle_final);
      const parent = path.dirname(bundle_final);
      try { if (is_dir(parent) && !fs.readdirSync(parent).length) fs.rmdirSync(parent); } catch { /* Non-fatal. */ }
    }
    new_sub.submission_truth = "unavailable";
    new_sub.code_unavailable_reason = "No public author-republished source declared in data/contest-sources.yaml; add an entry if a public URL becomes available.";
    delete new_sub.code_path;
    return [new_sub, false, null];
  }
  const kind = entry.kind;
  const origin_url = entry.origin_url ?? "";
  const files = [];
  if (["discord-only", "unavailable-public"].includes(kind)) {
    if (is_dir(bundle_final)) remove_tree(bundle_final);
    new_sub.submission_truth = "unavailable";
    new_sub.code_unavailable_reason = entry.reason ?? `kind=${kind}; no public code`;
    delete new_sub.code_path;
    return [new_sub, false, null];
  }
  const parent = path.dirname(bundle_final);
  fs.mkdirSync(parent, { recursive: true });
  const bundle_work = path.join(parent, `.${path.basename(bundle_final)}.new`);
  if (exists(bundle_work)) remove_tree(bundle_work);
  fs.mkdirSync(bundle_work, { recursive: true });
  let swap_on_exit = false;
  try {
    if (kind === "github-file") {
      const repo = entry.upstream_repo;
      if (repo === undefined) throw new TypeError("missing upstream_repo");
      const sha = entry.upstream_sha;
      if (!sha || ["HEAD", "MAIN", "MASTER", ""].includes(String(sha).trim().toUpperCase())) return [new_sub, false,
        `manifest kind=github-file for ${repo} needs a pinned upstream_sha (40-char commit SHA or short prefix); refusing to fetch at '${sha || "missing"}' which would produce an unpinned, unverifiable bundle`];
      for (const spec of entry.files || []) {
        const src = spec.upstream_path;
        if (src === undefined) throw new TypeError("missing upstream_path");
        const out_name = spec.local_name || src.split("/").at(-1);
        const out = path.join(bundle_work, out_name);
        const doc = JSON.parse(run_gh(["api", `/repos/${repo}/contents/${src}?ref=${sha}`]).toString("utf8"));
        if (doc.type !== "file") return [new_sub, false, `non-file response for ${repo}:${src}`];
        fs.writeFileSync(out, decode_content(doc.content));
        files.push({ local_path: out_name, role: "upstream-file", mode: "verbatim", upstream_path: src, sha256: sha256_of(out) });
      }
      fs.writeFileSync(path.join(bundle_work, "PROVENANCE.yaml"), stringify({
        origin_url, upstream_repo: repo, upstream_sha: sha, license: entry.license ?? "inherits-from-upstream",
        retrieved_at: "2026-04-17", asset_mode: "verbatim", size_cap_truncated: false, generated_by: GENERATED_BY,
        source_contest_id: contest_page_id || `contest-${contest_slug}-${problem_slug}`, files,
      }));
      new_sub.submission_truth = entry.official ? "official-submission" : "author-published-posthoc";
      const canonical = _resolve_canonical_file(entry, files);
      if (canonical === null) return [new_sub, false, `manifest canonical_file='${py_str(entry.canonical_file)}' does not match any local_path in the fetched bundle; fix the manifest`];
      new_sub.code_path = `artifacts/contests/${contest_slug}/${problem_slug}/submissions/${ra_slug}/${canonical}`;
      delete new_sub.code_unavailable_reason;
      swap_on_exit = true;
      return [new_sub, true, null];
    }
    if (kind === "inline-from-blog") {
      const blog_slug = entry.blog_slug;
      if (blog_slug === undefined) throw new TypeError("missing blog_slug");
      const blog_bundle = path.join(REPO, "artifacts", "blogs", blog_slug);
      const blog_code_dir = path.join(blog_bundle, "code");
      if (!is_dir(blog_code_dir)) return [new_sub, false, `blog code bundle ${blog_slug} not extracted yet`];
      const blog_manifest_path = path.join(blog_bundle, "MANIFEST.yaml");
      const blog_files = new Map();
      if (is_file(blog_manifest_path)) {
        try {
          const bm = parse(fs.readFileSync(blog_manifest_path, "utf8")) || {};
          for (const file of bm.files || []) if (file.local_path?.startsWith("code/")) blog_files.set(file.local_path.slice(5), file);
        } catch (e) { if (e.name !== "YAMLParseError") throw e; }
      }
      const want = new Set(entry.files || []);
      for (const name of fs.readdirSync(blog_code_dir).sort()) {
        const source = path.join(blog_code_dir, name);
        if (name === "PROVENANCE.yaml" || !is_file(source) || (want.size && !want.has(name))) continue;
        const dst = path.join(bundle_work, name);
        fs.copyFileSync(source, dst);
        fs.chmodSync(dst, fs.statSync(source).mode & 0o7777);
        const heading = blog_files.get(name)?.heading_path || `(heading not recorded in ${blog_slug}/MANIFEST.yaml)`;
        files.push({ local_path: name, role: "extracted-block", mode: "extracted", upstream_path: `sources/blogs/${blog_slug}.md`, heading_path: heading, sha256: sha256_of(dst) });
      }
      if (!files.length) return [new_sub, false, "no matching files in blog bundle"];
      fs.writeFileSync(path.join(bundle_work, "PROVENANCE.yaml"), stringify({
        origin_url, upstream_repo: `blog/${blog_slug}`, upstream_sha: "none", license: "inherits-from-source-blog",
        retrieved_at: "2026-04-17", asset_mode: "extracted", size_cap_truncated: false, generated_by: GENERATED_BY,
        source_contest_id: contest_page_id || `contest-${contest_slug}-${problem_slug}`, files,
      }));
      new_sub.submission_truth = "reconstructed-from-blog";
      const canonical = _resolve_canonical_file(entry, files);
      if (canonical === null) return [new_sub, false, `manifest canonical_file='${py_str(entry.canonical_file)}' does not match any local_path in the reconstructed bundle for ${blog_slug}`];
      new_sub.code_path = `artifacts/contests/${contest_slug}/${problem_slug}/submissions/${ra_slug}/${canonical}`;
      delete new_sub.code_unavailable_reason;
      swap_on_exit = true;
      return [new_sub, true, null];
    }
    return [new_sub, false, `unknown kind '${py_str(kind)}'`];
  } catch (e) {
    if (e.name === "CalledProcessError") return [new_sub, false, `gh failed: ${e.stderr.toString("utf8").trim().slice(0, 120)}`];
    return [new_sub, false, `${e.name}: ${e.message}`];
  } finally {
    if (swap_on_exit) {
      let previous = null;
      if (exists(bundle_final)) {
        previous = path.join(parent, `.${path.basename(bundle_final)}.prev`);
        if (exists(previous)) ignore_remove(previous);
        try { fs.renameSync(bundle_final, previous); } catch { previous = null; }
      }
      try { fs.renameSync(bundle_work, bundle_final); }
      catch (e) {
        if (previous !== null && exists(previous)) { try { fs.renameSync(previous, bundle_final); } catch { /* Restore when possible. */ } }
        if (exists(bundle_work)) ignore_remove(bundle_work);
        throw new BundleSwapError(`atomic bundle swap failed for ${bundle_final}: ${e.message}; prior bundle restored if possible`);
      }
      if (previous !== null && exists(previous)) ignore_remove(previous);
    } else if (exists(bundle_work)) ignore_remove(bundle_work);
  }
}

function* markdown_files(root) {
  if (!is_dir(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* markdown_files(full);
    else if (entry.name.endsWith(".md")) yield full;
  }
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } } }).values; }
  catch (e) { console.error(`ERROR: ${e.message}`); return 2; }
  if (args.help) { console.log("Usage: collect-contest-code.mjs [-h] [--dry-run]\nCollect contest submission code from data/contest-sources.yaml."); return 0; }
  const manifest = load_manifest();
  let wrote = 0, unavailable = 0;
  const fails = [];
  for (const file of [...markdown_files(CONTESTS_SRC)].sort()) {
    const loaded = load_md(file);
    if (!loaded) continue;
    const [match, fm] = loaded;
    const subs = fm.submissions || [];
    if (!subs.length) continue;
    const new_subs = [];
    let changed = false;
    for (const [i, sub] of subs.entries()) {
      if (!mapping(sub) || args["dry-run"]) { new_subs.push(sub); continue; }
      let next, ok, error;
      try { [next, ok, error] = collect_one(file, i, sub, manifest, fm.id || null); }
      catch (e) {
        if (!(e instanceof BundleSwapError)) throw e;
        [next, ok, error] = [{ ...sub }, false, `swap failed: ${e.message}`];
      }
      if (error) { fails.push(`${path.relative(REPO, file)}[${i}]: ${error}`); next = { ...sub }; }
      if (ok) wrote++;
      else if (next.submission_truth === "unavailable") unavailable++;
      if (!isDeepStrictEqual(next, sub)) changed = true;
      new_subs.push(next);
    }
    if (changed) { fm.submissions = new_subs; save_md(file, match, fm); }
  }
  console.log(`Collected code for ${wrote} submissions; marked ${unavailable} as unavailable.`);
  if (fails.length) { console.error(`\n${fails.length} soft failure(s):`); for (const fail of fails) console.error(`  ${fail}`); return 1; }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
