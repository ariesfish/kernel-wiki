#!/usr/bin/env node
/** Extract fenced blog code and verify it against the current source bytes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseMaintenance as parse, stringifyMaintenance as stringify } from "./lib/yaml.mjs";

const configured_root = process.env.BLACKWELL_WIKI_ROOT;
export const REPO_ROOT = configured_root
  ? path.resolve(configured_root === "~" ? os.homedir() : configured_root.replace(/^~\//, `${os.homedir()}/`))
  : path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const BLOGS_DIR = path.join(REPO_ROOT, "sources", "blogs");
export const OUT_DIR = path.join(REPO_ROOT, "artifacts", "blogs");
export const EXT_MAP = Object.freeze({
  cuda: "cu", cu: "cu", cpp: "cpp", "c++": "cpp", cxx: "cpp", c: "cpp",
  cuh: "cuh", ptx: "ptx", asm: "ptx", python: "py", py: "py", triton: "py",
  cute: "py", yaml: "yaml", bash: "sh", shell: "sh", sh: "sh", json: "json",
});
export const SLUGIFY_RE = /[^a-z0-9]+/g;
const GENERATED_BY = "scripts/extract_blog_code.py"; // Historical on-disk byte contract.
const is_file = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const is_dir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const entries = (p) => is_dir(p) ? fs.readdirSync(p).sort() : [];
const splitlines = (text) => text ? text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).filter((_, i, a) => i < a.length - 1 || a[i] !== "") : [];

export function slugify(s) {
  return s.toLowerCase().trim().replace(SLUGIFY_RE, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";
}

export function _looks_like_code_fence(body) {
  const lines = splitlines(body.trim()).filter((line) => line.trim());
  if (!lines.length) return false;
  const bullets = lines.filter((line) => /^\s*([-*•]|\d+[.)])\s+\S/.test(line));
  if (bullets.length / lines.length > 0.5) return false;
  const non_comment = lines.filter((line) => !/^\s*(?:\/\/|#|\/\*|\*\/|\*|<!--)/.test(line));
  const structure = /[;{}]|\b(?:def|class|struct|template|namespace|typedef|using|for|while|if|else|return|extern|static|inline|void|__global__|__device__|__host__|__forceinline__|__shared__|asm\s+volatile)\b/;
  return non_comment.some((line) => structure.test(line));
}

export function is_extractable_block(lang, body) {
  if (!body.trim()) return false;
  if (lang && Object.hasOwn(EXT_MAP, lang)) return true;
  return _looks_like_code_fence(body);
}

export function* parse_markdown(md_path) {
  let text;
  try { text = fs.readFileSync(md_path, "utf8"); } catch { return; }
  // Python's read_text uses universal newlines, including in frontmatter.
  text = text.replace(/\r\n?/g, "\n");
  const frontmatter = /^---\s*\n.*?\n---\s*\n(.*)/s.exec(text);
  const lines = splitlines(frontmatter ? frontmatter[1] : text);
  const stack = [];
  let i = 0;
  while (i < lines.length) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].replace(/#+$/, "").trim();
      while (stack.length && stack.at(-1)[0] >= level) stack.pop();
      stack.push([level, title]);
      i++;
      continue;
    }
    // Match the original parser: exactly three backticks, with no indentation.
    const fence = /^```(\S*)\s*$/.exec(lines[i]);
    if (!fence) { i++; continue; }
    const open = i++;
    const lang = fence[1].trim().toLowerCase();
    const buf = [];
    while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
    if (i < lines.length) i++;
    let previous = open - 1;
    while (previous >= 0 && !lines[previous].trim()) previous--;
    if (previous >= 0 && /<!--\s*extract-skip\b.*?-->/i.test(lines[previous])) continue;
    const heading_path = stack.length ? stack.map(([level, title]) => `${"#".repeat(level)} ${title}`).join(" > ") : "(root)";
    yield [heading_path, lang, `${buf.join("\n")}\n`];
  }
}

export function sha256_bytes(b) {
  return createHash("sha256").update(b).digest("hex");
}

export function _derive_filename(idx, heading_path, lang, seen_names) {
  const leaf = heading_path === "(root)" ? "root" : heading_path.split(" > ").at(-1);
  const ext = Object.hasOwn(EXT_MAP, lang) ? EXT_MAP[lang] : "txt";
  const original = `${String(idx).padStart(2, "0")}-${slugify(leaf.replace(/^#+\s*/, ""))}.${ext}`;
  let fn = original;
  let k = 2;
  while (seen_names.has(fn)) fn = original.replaceAll(`.${ext}`, `-${k++}.${ext}`);
  seen_names.add(fn);
  return [fn, ext];
}

export function _file_header(slug, heading_path, lang, ext) {
  if (ext === "json") return "";
  const prefix = ["cu", "cuh", "cpp", "ptx", "h", "hpp"].includes(ext) ? "//" : "#";
  return `${prefix} Extracted from sources/blogs/${slug}.md by ${GENERATED_BY}\n`
    + `${prefix} Heading: ${heading_path}\n`
    + `${prefix} Original fence language: ${lang}\n`
    + `${prefix} See artifacts/blogs/${slug}/code/PROVENANCE.yaml for origin + license metadata.\n\n`;
}

export function _expected_block_content(slug, heading_path, lang, body, ext) {
  return _file_header(slug, heading_path, lang, ext) + body;
}

export function extract_one_blog(blog_md, force = false) {
  const slug = path.basename(blog_md, path.extname(blog_md));
  const bundle = path.join(OUT_DIR, slug);
  const code_dir = path.join(bundle, "code");
  const manifest_path = path.join(bundle, "MANIFEST.yaml");
  const blocks = [...parse_markdown(blog_md)];
  let md_text;
  try { md_text = fs.readFileSync(blog_md, "utf8").replace(/\r\n?/g, "\n"); } catch { return [0, false]; }
  const mf = /^---\s*\n(.*?)\n---/s.exec(md_text);
  const fm = mf ? parse(mf[1]) : {};
  const mapping = fm && typeof fm === "object" && !Array.isArray(fm) ? fm : {};
  const origin_url = mapping.url ?? "";
  const retrieved = mapping.retrieved_at ?? "";
  const code_blocks = blocks.filter(([, lang, body]) => is_extractable_block(lang, body));
  if (!code_blocks.length) {
    if (is_dir(code_dir)) fs.rmSync(code_dir, { recursive: true });
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(manifest_path, stringify({ slug, origin_url, code_present: false, generated_by: GENERATED_BY }));
    return [0, false];
  }
  if (is_dir(code_dir)) {
    for (const name of entries(code_dir)) {
      const file = path.join(code_dir, name);
      if (is_file(file)) fs.unlinkSync(file);
    }
  }
  fs.mkdirSync(code_dir, { recursive: true });
  const manifest_files = [];
  const files_entries = [];
  const seen = new Set();
  for (const [index, [heading_path, lang, body]] of code_blocks.entries()) {
    const [fn, ext] = _derive_filename(index + 1, heading_path, lang, seen);
    const content = _expected_block_content(slug, heading_path, lang, body, ext);
    fs.writeFileSync(path.join(code_dir, fn), content, "utf8");
    const sha256 = sha256_bytes(Buffer.from(content));
    manifest_files.push({ local_path: `code/${fn}`, heading_path, fence_lang: lang, sha256 });
    files_entries.push({ local_path: fn, role: "extracted-block", mode: "extracted", upstream_path: "inline-in-blog-markdown", heading_path, sha256 });
  }
  fs.writeFileSync(manifest_path, stringify({ slug, origin_url, code_present: true, total_blocks: manifest_files.length, generated_by: GENERATED_BY, files: manifest_files }));
  fs.writeFileSync(path.join(code_dir, "PROVENANCE.yaml"), stringify({
    origin_url, upstream_repo: "blog", upstream_sha: "none", license: "inherits-from-source-blog",
    retrieved_at: retrieved || "", asset_mode: "extracted", generated_by: GENERATED_BY,
    size_cap_truncated: false, files: files_entries,
  }));
  return [manifest_files.length, true];
}

export function check_one_blog(slug) {
  const bundle = path.join(OUT_DIR, slug);
  const manifest_path = path.join(bundle, "MANIFEST.yaml");
  const blog_md = path.join(BLOGS_DIR, `${slug}.md`);
  const fresh_blocks = is_file(blog_md) ? [...parse_markdown(blog_md)].filter(([, lang, body]) => is_extractable_block(lang, body)) : [];
  const source_has_code = fresh_blocks.length > 0;
  if (!is_file(manifest_path)) {
    if (!is_file(blog_md)) return [`${slug}: neither source markdown nor extraction bundle exists`];
    if (source_has_code) return [`${slug}: source blog has fenced code but artifacts/blogs/${slug}/ bundle is missing — run scripts/extract_blog_code.py to generate it`];
    return [];
  }
  let manifest;
  try { manifest = parse(fs.readFileSync(manifest_path, "utf8")) || {}; }
  catch (e) { return [`${slug}: MANIFEST.yaml parse error: ${e.message}`]; }
  const errors = [];
  if (!manifest.code_present) {
    if (source_has_code) errors.push(`${slug}: manifest code_present=false but source markdown has fenced code — re-run scripts/extract_blog_code.py`);
    return errors;
  }
  if (!is_file(blog_md)) return [`${slug}: source blog not found at ${path.relative(REPO_ROOT, blog_md)}`];
  const files = manifest.files || [];
  if (fresh_blocks.length !== files.length) errors.push(`${slug}: markdown-vs-manifest drift (markdown has ${fresh_blocks.length} code blocks, manifest has ${files.length})`);
  const seen = new Set();
  const expected = new Map();
  const hashes = new Map();
  for (const [idx, [hp, lang, body]] of fresh_blocks.entries()) {
    const [fn, ext] = _derive_filename(idx + 1, hp, lang, seen);
    const bytes = Buffer.from(_expected_block_content(slug, hp, lang, body, ext));
    expected.set(fn, bytes);
    hashes.set(fn, sha256_bytes(bytes));
  }
  const filename = (lp) => lp?.startsWith("code/") ? lp.slice(5) : lp;
  for (const entry of files) {
    const lp = entry.local_path;
    if (!lp) continue;
    const fn = filename(lp);
    if (!expected.has(fn)) {
      errors.push(`${slug}/${lp}: manifest entry refers to a file no longer produced from the source markdown (renamed or dropped block)`);
      continue;
    }
    if (entry.sha256 && entry.sha256 !== hashes.get(fn)) errors.push(`${slug}/${lp}: manifest sha256 disagrees with fresh extraction (markdown body changed; re-run scripts/extract_blog_code.py)`);
  }
  for (const fn of expected.keys()) {
    if (!files.some((entry) => filename(entry.local_path) === fn)) errors.push(`${slug}/code/${fn}: fresh extraction produces this file but the manifest does not list it (new block in markdown)`);
  }
  for (const entry of files) {
    const lp = entry.local_path;
    if (!lp || !entry.sha256) continue;
    const fn = filename(lp);
    const fp = path.join(bundle, lp);
    if (!is_file(fp)) { errors.push(`${slug}/${lp}: file missing`); continue; }
    const bytes = fs.readFileSync(fp);
    if (sha256_bytes(bytes) !== entry.sha256) errors.push(`${slug}/${lp}: SHA-256 mismatch (hand-edit detected)`);
    if (expected.has(fn) && !bytes.equals(expected.get(fn))) errors.push(`${slug}/${lp}: on-disk bytes differ from fresh extraction of the current markdown (source body changed; re-run scripts/extract_blog_code.py)`);
  }
  return errors;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs({ args: argv, options: {
      check: { type: "string" }, "check-all": { type: "boolean" }, only: { type: "string" },
      help: { type: "boolean", short: "h" },
    } }).values;
  } catch (e) { console.error(`ERROR: ${e.message}`); return 2; }
  if (args.help) {
    console.log("Usage: extract-blog-code.mjs [-h] [--check SLUG] [--check-all] [--only SLUG]\nExtract fenced code blocks from sources/blogs/*.md into standalone files.");
    return 0;
  }
  fs.mkdirSync(BLOGS_DIR, { recursive: true });
  const blogs = entries(BLOGS_DIR).filter((name) => name.endsWith(".md")).map((name) => path.join(BLOGS_DIR, name));
  if (args.check || args["check-all"]) {
    const errors = [];
    if (args["check-all"]) {
      const checked = new Set();
      for (const blog of blogs) {
        const slug = path.basename(blog, ".md");
        checked.add(slug);
        errors.push(...check_one_blog(slug));
      }
      for (const name of entries(OUT_DIR)) if (is_dir(path.join(OUT_DIR, name)) && !checked.has(name)) errors.push(...check_one_blog(name));
    } else errors.push(...check_one_blog(args.check));
    if (errors.length) {
      for (const error of errors) console.error(`  FAIL: ${error}`);
      return 1;
    }
    console.log("All checked blogs match their source markdown.");
    return 0;
  }
  let total = 0;
  let with_code = 0;
  for (const blog of blogs) {
    const slug = path.basename(blog, ".md");
    if (args.only && slug !== args.only) continue;
    const [n, had_code] = extract_one_blog(blog);
    total++;
    if (had_code) { with_code++; console.log(`  ${slug}: extracted ${n} code block(s)`); }
    else console.log(`  ${slug}: code_present: false (no fenced blocks)`);
  }
  console.log(`\nProcessed ${total} blog(s), ${with_code} with extractable code.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
