#!/usr/bin/env node
/** Extract fenced blog code and verify it against the current source bytes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseMaintenance as parse, stringifyMaintenance as stringify } from "./lib/yaml.mjs";
const configuredRoot = process.env.BLACKWELL_WIKI_ROOT;
export const REPO_ROOT = configuredRoot
  ? path.resolve(
      configuredRoot === "~" ? os.homedir() : configuredRoot.replace(/^~\//, `${os.homedir()}/`),
    )
  : path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const BLOGS_DIR = path.join(REPO_ROOT, "sources", "blogs");
export const OUT_DIR = path.join(REPO_ROOT, "artifacts", "blogs");
export const EXT_MAP = Object.freeze({
  cuda: "cu",
  cu: "cu",
  cpp: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  c: "cpp",
  cuh: "cuh",
  ptx: "ptx",
  asm: "ptx",
  python: "py",
  py: "py",
  triton: "py",
  cute: "py",
  yaml: "yaml",
  bash: "sh",
  shell: "sh",
  sh: "sh",
  json: "json",
});
export const SLUGIFY_RE = /[^a-z0-9]+/g;
const GENERATED_BY = "scripts/extract_blog_code.py"; // Historical on-disk byte contract.
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const entries = (p) => (isDir(p) ? fs.readdirSync(p).sort() : []);
const splitlines = (text) =>
  text
    ? text
        // eslint-disable-next-line no-control-regex -- Keep extracted block boundaries and archived hashes stable.
        .split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
        .filter((_, i, a) => i < a.length - 1 || a[i] !== "")
    : [];
export function slugify(s) {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(SLUGIFY_RE, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}
export function looksLikeCodeFence(body) {
  const lines = splitlines(body.trim()).filter((line) => line.trim());
  if (!lines.length) {
    return false;
  }
  const bullets = lines.filter((line) => /^\s*([-*•]|\d+[.)])\s+\S/.test(line));
  if (bullets.length / lines.length > 0.5) {
    return false;
  }
  const nonComment = lines.filter((line) => !/^\s*(?:\/\/|#|\/\*|\*\/|\*|<!--)/.test(line));
  const structure =
    /[;{}]|\b(?:def|class|struct|template|namespace|typedef|using|for|while|if|else|return|extern|static|inline|void|__global__|__device__|__host__|__forceinline__|__shared__|asm\s+volatile)\b/;
  return nonComment.some((line) => structure.test(line));
}
export function isExtractableBlock(lang, body) {
  if (!body.trim()) {
    return false;
  }
  if (lang && Object.hasOwn(EXT_MAP, lang)) {
    return true;
  }
  return looksLikeCodeFence(body);
}
export function* parseMarkdown(mdPath) {
  let text;
  try {
    text = fs.readFileSync(mdPath, "utf8");
  } catch {
    return;
  }
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
      while (stack.length && stack.at(-1)[0] >= level) {
        stack.pop();
      }
      stack.push([level, title]);
      i++;
      continue;
    }
    // Match the original parser: exactly three backticks, with no indentation.
    const fence = /^```(\S*)\s*$/.exec(lines[i]);
    if (!fence) {
      i++;
      continue;
    }
    const open = i++;
    const lang = fence[1].trim().toLowerCase();
    const buf = [];
    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    if (i < lines.length) {
      i++;
    }
    let previous = open - 1;
    while (previous >= 0 && !lines[previous].trim()) {
      previous--;
    }
    if (previous >= 0 && /<!--\s*extract-skip\b.*?-->/i.test(lines[previous])) {
      continue;
    }
    const headingPath = stack.length
      ? stack.map(([level, title]) => `${"#".repeat(level)} ${title}`).join(" > ")
      : "(root)";
    yield [headingPath, lang, `${buf.join("\n")}\n`];
  }
}
export function sha256Bytes(b) {
  return createHash("sha256").update(b).digest("hex");
}
export function deriveFilename(idx, headingPath, lang, seenNames) {
  const leaf = headingPath === "(root)" ? "root" : headingPath.split(" > ").at(-1);
  const ext = Object.hasOwn(EXT_MAP, lang) ? EXT_MAP[lang] : "txt";
  const original = `${String(idx).padStart(2, "0")}-${slugify(leaf.replace(/^#+\s*/, ""))}.${ext}`;
  let fn = original;
  let k = 2;
  while (seenNames.has(fn)) {
    fn = original.replaceAll(`.${ext}`, `-${k++}.${ext}`);
  }
  seenNames.add(fn);
  return [fn, ext];
}
export function fileHeader(slug, headingPath, lang, ext) {
  if (ext === "json") {
    return "";
  }
  const prefix = ["cu", "cuh", "cpp", "ptx", "h", "hpp"].includes(ext) ? "//" : "#";
  return (
    `${prefix} Extracted from sources/blogs/${slug}.md by ${GENERATED_BY}\n` +
    `${prefix} Heading: ${headingPath}\n` +
    `${prefix} Original fence language: ${lang}\n` +
    `${prefix} See artifacts/blogs/${slug}/code/PROVENANCE.yaml for origin + license metadata.\n\n`
  );
}
export function expectedBlockContent(slug, headingPath, lang, body, ext) {
  return fileHeader(slug, headingPath, lang, ext) + body;
}
export function extractOneBlog(blogMd, force = false) {
  const slug = path.basename(blogMd, path.extname(blogMd));
  const bundle = path.join(OUT_DIR, slug);
  const codeDir = path.join(bundle, "code");
  const manifestPath = path.join(bundle, "MANIFEST.yaml");
  const blocks = [...parseMarkdown(blogMd)];
  let mdText;
  try {
    mdText = fs.readFileSync(blogMd, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return [0, false];
  }
  const mf = /^---\s*\n(.*?)\n---/s.exec(mdText);
  const fm = mf ? parse(mf[1]) : {};
  const mapping = fm && typeof fm === "object" && !Array.isArray(fm) ? fm : {};
  const originUrl = mapping.url ?? "";
  const retrieved = mapping.retrieved_at ?? "";
  const codeBlocks = blocks.filter(([, lang, body]) => isExtractableBlock(lang, body));
  if (!codeBlocks.length) {
    if (isDir(codeDir)) {
      fs.rmSync(codeDir, {
        recursive: true,
      });
    }
    fs.mkdirSync(bundle, {
      recursive: true,
    });
    fs.writeFileSync(
      manifestPath,
      stringify({
        slug,
        origin_url: originUrl,
        code_present: false,
        generated_by: GENERATED_BY,
      }),
    );
    return [0, false];
  }
  if (isDir(codeDir)) {
    for (const name of entries(codeDir)) {
      const file = path.join(codeDir, name);
      if (isFile(file)) {
        fs.unlinkSync(file);
      }
    }
  }
  fs.mkdirSync(codeDir, {
    recursive: true,
  });
  const manifestFiles = [];
  const filesEntries = [];
  const seen = new Set();
  for (const [index, [headingPath, lang, body]] of codeBlocks.entries()) {
    const [fn, ext] = deriveFilename(index + 1, headingPath, lang, seen);
    const content = expectedBlockContent(slug, headingPath, lang, body, ext);
    fs.writeFileSync(path.join(codeDir, fn), content, "utf8");
    const sha256 = sha256Bytes(Buffer.from(content));
    manifestFiles.push({
      local_path: `code/${fn}`,
      heading_path: headingPath,
      fence_lang: lang,
      sha256,
    });
    filesEntries.push({
      local_path: fn,
      role: "extracted-block",
      mode: "extracted",
      upstream_path: "inline-in-blog-markdown",
      heading_path: headingPath,
      sha256,
    });
  }
  fs.writeFileSync(
    manifestPath,
    stringify({
      slug,
      origin_url: originUrl,
      code_present: true,
      total_blocks: manifestFiles.length,
      generated_by: GENERATED_BY,
      files: manifestFiles,
    }),
  );
  fs.writeFileSync(
    path.join(codeDir, "PROVENANCE.yaml"),
    stringify({
      origin_url: originUrl,
      upstream_repo: "blog",
      upstream_sha: "none",
      license: "inherits-from-source-blog",
      retrieved_at: retrieved || "",
      asset_mode: "extracted",
      generated_by: GENERATED_BY,
      size_cap_truncated: false,
      files: filesEntries,
    }),
  );
  return [manifestFiles.length, true];
}
export function checkOneBlog(slug) {
  const bundle = path.join(OUT_DIR, slug);
  const manifestPath = path.join(bundle, "MANIFEST.yaml");
  const blogMd = path.join(BLOGS_DIR, `${slug}.md`);
  const freshBlocks = isFile(blogMd)
    ? [...parseMarkdown(blogMd)].filter(([, lang, body]) => isExtractableBlock(lang, body))
    : [];
  const sourceHasCode = freshBlocks.length > 0;
  if (!isFile(manifestPath)) {
    if (!isFile(blogMd)) {
      return [`${slug}: neither source markdown nor extraction bundle exists`];
    }
    if (sourceHasCode) {
      return [
        `${slug}: source blog has fenced code but artifacts/blogs/${slug}/ bundle is missing — run scripts/extract_blog_code.py to generate it`,
      ];
    }
    return [];
  }
  let manifest;
  try {
    manifest = parse(fs.readFileSync(manifestPath, "utf8")) || {};
  } catch (e) {
    return [`${slug}: MANIFEST.yaml parse error: ${e.message}`];
  }
  const errors = [];
  if (!manifest.code_present) {
    if (sourceHasCode) {
      errors.push(
        `${slug}: manifest code_present=false but source markdown has fenced code — re-run scripts/extract_blog_code.py`,
      );
    }
    return errors;
  }
  if (!isFile(blogMd)) {
    return [`${slug}: source blog not found at ${path.relative(REPO_ROOT, blogMd)}`];
  }
  const files = manifest.files || [];
  if (freshBlocks.length !== files.length) {
    errors.push(
      `${slug}: markdown-vs-manifest drift (markdown has ${freshBlocks.length} code blocks, manifest has ${files.length})`,
    );
  }
  const seen = new Set();
  const expected = new Map();
  const hashes = new Map();
  for (const [idx, [hp, lang, body]] of freshBlocks.entries()) {
    const [fn, ext] = deriveFilename(idx + 1, hp, lang, seen);
    const bytes = Buffer.from(expectedBlockContent(slug, hp, lang, body, ext));
    expected.set(fn, bytes);
    hashes.set(fn, sha256Bytes(bytes));
  }
  const filename = (lp) => (lp?.startsWith("code/") ? lp.slice(5) : lp);
  for (const entry of files) {
    const lp = entry.local_path;
    if (!lp) {
      continue;
    }
    const fn = filename(lp);
    if (!expected.has(fn)) {
      errors.push(
        `${slug}/${lp}: manifest entry refers to a file no longer produced from the source markdown (renamed or dropped block)`,
      );
      continue;
    }
    if (entry.sha256 && entry.sha256 !== hashes.get(fn)) {
      errors.push(
        `${slug}/${lp}: manifest sha256 disagrees with fresh extraction (markdown body changed; re-run scripts/extract_blog_code.py)`,
      );
    }
  }
  for (const fn of expected.keys()) {
    if (!files.some((entry) => filename(entry.local_path) === fn)) {
      errors.push(
        `${slug}/code/${fn}: fresh extraction produces this file but the manifest does not list it (new block in markdown)`,
      );
    }
  }
  for (const entry of files) {
    const lp = entry.local_path;
    if (!lp || !entry.sha256) {
      continue;
    }
    const fn = filename(lp);
    const fp = path.join(bundle, lp);
    if (!isFile(fp)) {
      errors.push(`${slug}/${lp}: file missing`);
      continue;
    }
    const bytes = fs.readFileSync(fp);
    if (sha256Bytes(bytes) !== entry.sha256) {
      errors.push(`${slug}/${lp}: SHA-256 mismatch (hand-edit detected)`);
    }
    if (expected.has(fn) && !bytes.equals(expected.get(fn))) {
      errors.push(
        `${slug}/${lp}: on-disk bytes differ from fresh extraction of the current markdown (source body changed; re-run scripts/extract_blog_code.py)`,
      );
    }
  }
  return errors;
}
export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        check: {
          type: "string",
        },
        "check-all": {
          type: "boolean",
        },
        only: {
          type: "string",
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    }).values;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  if (args.help) {
    console.log(
      "Usage: extract-blog-code.mjs [-h] [--check SLUG] [--check-all] [--only SLUG]\nExtract fenced code blocks from sources/blogs/*.md into standalone files.",
    );
    return 0;
  }
  fs.mkdirSync(BLOGS_DIR, {
    recursive: true,
  });
  const blogs = entries(BLOGS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(BLOGS_DIR, name));
  if (args.check || args["check-all"]) {
    const errors = [];
    if (args["check-all"]) {
      const checked = new Set();
      for (const blog of blogs) {
        const slug = path.basename(blog, ".md");
        checked.add(slug);
        errors.push(...checkOneBlog(slug));
      }
      for (const name of entries(OUT_DIR)) {
        if (isDir(path.join(OUT_DIR, name)) && !checked.has(name)) {
          errors.push(...checkOneBlog(name));
        }
      }
    } else {
      errors.push(...checkOneBlog(args.check));
    }
    if (errors.length) {
      for (const error of errors) {
        console.error(`  FAIL: ${error}`);
      }
      return 1;
    }
    console.log("All checked blogs match their source markdown.");
    return 0;
  }
  let total = 0;
  let withCode = 0;
  for (const blog of blogs) {
    const slug = path.basename(blog, ".md");
    if (args.only && slug !== args.only) {
      continue;
    }
    const [n, hadCode] = extractOneBlog(blog);
    total++;
    if (hadCode) {
      withCode++;
      console.log(`  ${slug}: extracted ${n} code block(s)`);
    } else {
      console.log(`  ${slug}: code_present: false (no fenced blocks)`);
    }
  }
  console.log(`\nProcessed ${total} blog(s), ${withCode} with extractable code.`);
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
