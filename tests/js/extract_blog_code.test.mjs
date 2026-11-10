import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as BLOG from "../../scripts/extract_blog_code.mjs";
import { parse, stringify } from "../../scripts/_yaml.mjs";
import { ROOT, import_in_root, put, run, temp_root } from "./checks-helpers.mjs";

const markdown = (code = "int value = 1;", heading = "Kernel") => `---\nurl: https://example.com/post\nauthor: Author\nretrieved_at: '2026-08-18'\n---\n# Blog\n## ${heading}\n\n\`\`\`cuda\n${code}\n\`\`\`\n`;

test("existing blog check-all passes and regenerated code preserves available historical bytes and hashes", async (t) => {
  const result = run("extract_blog_code.mjs", ["--check-all"]);
  assert.equal(result.status, 0, result.stderr);
  const root = temp_root(t);
  fs.cpSync(path.join(ROOT, "sources/blogs"), path.join(root, "sources/blogs"), { recursive: true });
  const blog = await import_in_root("extract_blog_code.mjs", root);
  let compared = 0;
  for (const name of fs.readdirSync(path.join(root, "sources/blogs")).filter((name) => name.endsWith(".md"))) {
    const slug = path.basename(name, ".md");
    blog.extract_one_blog(path.join(root, "sources/blogs", name));
    assert.deepEqual(blog.check_one_blog(slug), [], slug);
    const original_manifest = path.join(ROOT, "artifacts/blogs", slug, "MANIFEST.yaml");
    if (!fs.existsSync(original_manifest)) continue;
    const old = parse(fs.readFileSync(original_manifest, "utf8"));
    const fresh = parse(fs.readFileSync(path.join(root, "artifacts/blogs", slug, "MANIFEST.yaml"), "utf8"));
    if (old.code_present) assert.deepEqual(fresh, old, slug);
    else {
      // Historical no-code manifests may retain an earlier source URL; the
      // original check deliberately returns before checking that metadata.
      assert.equal(fresh.code_present, false, slug);
      assert.equal(fresh.generated_by, old.generated_by, slug);
    }
    for (const entry of old.files || []) {
      const bytes = fs.readFileSync(path.join(root, "artifacts/blogs", slug, entry.local_path));
      assert.deepEqual(bytes, fs.readFileSync(path.join(ROOT, "artifacts/blogs", slug, entry.local_path)), `${slug}/${entry.local_path}`);
      assert.equal(BLOG.sha256_bytes(bytes), entry.sha256);
      compared++;
    }
  }
  t.diagnostic(`Compared ${compared} historical extracted files byte for byte; current corpus may contain only no-code manifests.`);
});

test("fence heuristic rejects notes, formula, commands, and comment-only sketches", () => {
  for (const body of ["", " \n", "- item\n- another\nint x;", "1. attempt\n2) another", "# def fake():\n// return 0;", "/* kernel(); */", "x_hat = s * deq(q)", "DP=8, EP=8, TP=1", "vllm serve model", "Initial: grid=128"]) assert.equal(BLOG.is_extractable_block("", body), false, body);
  for (const body of ["def f():\n    return 1", "int x = 0;", "for (int x = 0; x < 5; x++) {}", "asm volatile (\"foo\")"]) assert.equal(BLOG.is_extractable_block("unknown", body), true, body);
  assert.equal(BLOG.is_extractable_block("python", "# declared code"), true);
  assert.equal(BLOG.is_extractable_block("json", '{"x": 1}'), true);
  assert.equal(BLOG.is_extractable_block("cuda", " \n"), false);
  assert.equal(BLOG.is_extractable_block("constructor", "plain prose"), false);
});

test("markdown parser preserves heading paths, CRLF normalization, skipped blocks, and unterminated fences", (t) => {
  const root = temp_root(t);
  const md = put(root, "post.md", ["---", "title: ignore", "---", "# A", "## B ##", "<!-- EXTRACT-SKIP synthesized -->", "", "```cuda", "skip();", "```", "### C", "```PY", "return 1", "```", "## D", "~~~cuda", "ignored();", "~~~", "```", "int x;"].join("\r\n"));
  assert.deepEqual([...BLOG.parse_markdown(md)], [["# A > ## B > ### C", "py", "return 1\n"], ["# A > ## D", "", "int x;\n"]]);
  assert.deepEqual([...BLOG.parse_markdown(path.join(root, "missing.md"))], []);
  assert.equal(BLOG.slugify(" 中文 "), "section");
  assert.equal(BLOG.slugify("A".repeat(70)).length, 60);
  const seen = new Set(["01-root.cu", "01-root-2.cu"]);
  assert.deepEqual(BLOG._derive_filename(1, "(root)", "cuda", seen), ["01-root-3.cu", "cu"]);
});

test("emitted headers retain historical .py markers, JSON stays valid, and repeat extraction is idempotent", async (t) => {
  const root = temp_root(t);
  const md = put(root, "sources/blogs/post.md", markdown() + '\n```json\n{"value": 1}\n```\n');
  const blog = await import_in_root("extract_blog_code.mjs", root);
  assert.deepEqual(blog.extract_one_blog(md, true), [2, true]);
  const code_dir = path.join(root, "artifacts/blogs/post/code");
  const bytes = fs.readFileSync(path.join(code_dir, "01-kernel.cu"));
  assert.equal(bytes.toString(), "// Extracted from sources/blogs/post.md by scripts/extract_blog_code.py\n// Heading: # Blog > ## Kernel\n// Original fence language: cuda\n// See artifacts/blogs/post/code/PROVENANCE.yaml for origin + license metadata.\n\nint value = 1;\n");
  assert.equal(BLOG.sha256_bytes(bytes), "158b62bfcfed18825f18d5125093432ed55a2c216ea689265e94c223fd253b5b");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(code_dir, "02-kernel.json"), "utf8")), { value: 1 });
  assert.match(blog._file_header("post", "(root)", "py", "py"), /^# Extracted/);
  const before = fs.readFileSync(path.join(root, "artifacts/blogs/post/MANIFEST.yaml"));
  put(root, "artifacts/blogs/post/code/orphan.cu", "old content");
  blog.extract_one_blog(md);
  assert.deepEqual(fs.readFileSync(path.join(root, "artifacts/blogs/post/MANIFEST.yaml")), before);
  assert.deepEqual(fs.readFileSync(path.join(code_dir, "01-kernel.cu")), bytes);
  assert.equal(fs.existsSync(path.join(code_dir, "orphan.cu")), false);
  const provenance = parse(fs.readFileSync(path.join(code_dir, "PROVENANCE.yaml"), "utf8"));
  assert.equal(provenance.retrieved_at, "2026-08-18");
  assert.equal(provenance.files[0].sha256, BLOG.sha256_bytes(bytes));
  assert.equal(provenance.files[0].local_path, "01-kernel.cu");
  assert.deepEqual(blog.check_one_blog("post"), []);
});

test("source changes with identical fence count and names are detected independently of manifest hashes", async (t) => {
  const root = temp_root(t);
  const md = put(root, "sources/blogs/post.md", markdown());
  const blog = await import_in_root("extract_blog_code.mjs", root);
  blog.extract_one_blog(md);
  fs.writeFileSync(md, markdown("int value = 2;"));
  let errors = blog.check_one_blog("post");
  assert.ok(errors.some((e) => e.includes("manifest sha256 disagrees")));
  assert.ok(errors.some((e) => e.includes("on-disk bytes differ")));
  const manifest_path = path.join(root, "artifacts/blogs/post/MANIFEST.yaml");
  const manifest = parse(fs.readFileSync(manifest_path, "utf8"));
  const content = blog._expected_block_content("post", "# Blog > ## Kernel", "cuda", "int value = 2;\n", "cu");
  manifest.files[0].sha256 = blog.sha256_bytes(Buffer.from(content));
  fs.writeFileSync(manifest_path, stringify(manifest));
  errors = blog.check_one_blog("post");
  assert.ok(errors.some((e) => e.includes("SHA-256 mismatch")));
  assert.ok(errors.some((e) => e.includes("on-disk bytes differ")));
});

test("bundle integrity checks cover hand edits, missing files, renamed and added blocks, and missing source", async (t) => {
  const root = temp_root(t);
  const md = put(root, "sources/blogs/post.md", markdown());
  const blog = await import_in_root("extract_blog_code.mjs", root);
  blog.extract_one_blog(md);
  const file = path.join(root, "artifacts/blogs/post/code/01-kernel.cu");
  fs.appendFileSync(file, "// hand edit\n");
  assert.ok(blog.check_one_blog("post").some((e) => e.includes("hand-edit detected")));
  fs.unlinkSync(file);
  assert.ok(blog.check_one_blog("post").some((e) => e.includes("file missing")));
  blog.extract_one_blog(md);
  fs.writeFileSync(md, markdown("int value = 1;", "Renamed") + "\n```py\nreturn 2\n```\n");
  const errors = blog.check_one_blog("post");
  for (const text of ["markdown-vs-manifest drift", "no longer produced", "manifest does not list"]) assert.ok(errors.some((e) => e.includes(text)), text);
  fs.unlinkSync(md);
  assert.ok(blog.check_one_blog("post").some((e) => e.includes("source blog not found")));
});

test("no-code transition removes stale directories and false/missing/malformed manifests fail when appropriate", async (t) => {
  const root = temp_root(t);
  const md = put(root, "sources/blogs/post.md", markdown());
  const blog = await import_in_root("extract_blog_code.mjs", root);
  assert.ok(blog.check_one_blog("post").some((e) => e.includes("bundle is missing")));
  blog.extract_one_blog(md);
  put(root, "artifacts/blogs/post/code/nested/stale.txt", "stale");
  fs.writeFileSync(md, "# Notes\n\n```\n- first attempt\n- second attempt\n```\n");
  assert.deepEqual(blog.extract_one_blog(md), [0, false]);
  assert.equal(fs.existsSync(path.join(root, "artifacts/blogs/post/code")), false);
  assert.deepEqual(blog.check_one_blog("post"), []);
  fs.writeFileSync(md, markdown());
  assert.ok(blog.check_one_blog("post").some((e) => e.includes("code_present=false")));
  put(root, "artifacts/blogs/post/MANIFEST.yaml", "files: [\n");
  assert.match(blog.check_one_blog("post")[0], /parse error/);
  put(root, "sources/blogs/prose.md", "# Pure prose\n");
  assert.deepEqual(blog.check_one_blog("prose"), []);
  assert.match(blog.check_one_blog("absent")[0], /neither source markdown nor extraction bundle exists/);
  assert.deepEqual(blog.extract_one_blog(path.join(root, "missing.md")), [0, false]);
});

test("blog CLI supports --only, --check, --check-all, checks new sources and orphan bundles, without Python", (t) => {
  const root = temp_root(t);
  const env = { PATH: "" };
  put(root, "sources/blogs/one.md", markdown());
  put(root, "sources/blogs/two.md", markdown());
  let result = run("extract_blog_code.mjs", ["--only", "one"], root, { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Processed 1 blog\(s\), 1 with extractable code/);
  assert.equal(run("extract_blog_code.mjs", ["--check", "one"], root, { env }).status, 0);
  result = run("extract_blog_code.mjs", ["--check-all"], root, { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /two: source blog has fenced code/);
  assert.equal(run("extract_blog_code.mjs", [], root, { env }).status, 0);
  fs.unlinkSync(path.join(root, "sources/blogs/two.md"));
  result = run("extract_blog_code.mjs", ["--check-all"], root, { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /two: source blog not found/);
  assert.equal(run("extract_blog_code.mjs", ["--check"], root).status, 2);
  assert.equal(run("extract_blog_code.mjs", ["--unknown"], root).status, 2);
  assert.equal(run("extract_blog_code.mjs", ["--help"], root).status, 0);
});
