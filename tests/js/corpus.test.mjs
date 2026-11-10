import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import {
  findPage,
  pageTypeOf,
  resolveArtifactDir,
  splitFrontmatter,
  WIKI_ROOT,
} from "../../scripts/_corpus.mjs";

test("splitFrontmatter separates a mapping from its body", () => {
  const [fm, body] = splitFrontmatter("---\nid: kernel-x\ntags: [a, b]\n---\n# Title\n");
  assert.deepEqual(fm, { id: "kernel-x", tags: ["a", "b"] });
  assert.equal(body, "# Title\n");
});

test("splitFrontmatter returns the content when there is no frontmatter", () => {
  const content = "# No frontmatter\n";
  const [fm, body] = splitFrontmatter(content);
  assert.equal(fm, null);
  assert.equal(body, content);
});

test("splitFrontmatter handles CRLF", () => {
  const [fm, body] = splitFrontmatter("---\r\nid: kernel-x\r\n---\r\nbody\r\n");
  assert.deepEqual(fm, { id: "kernel-x" });
  assert.equal(body, "body\r\n");
});

test("findPage resolves an id and a relative path", () => {
  const byId = findPage("kernel-flash-attention-4");
  assert.ok(byId, "expected the known page id to resolve");
  assert.equal(path.relative(WIKI_ROOT, byId), "wiki/kernels/flash-attention-4.md");

  const byPath = findPage("wiki/kernels/flash-attention-4.md");
  assert.equal(byPath, byId);
  assert.equal(findPage("no-such-page-id"), null);
});

test("pageTypeOf follows the wiki type or the sources directory", () => {
  assert.equal(pageTypeOf({ type: "kernel" }, "wiki/kernels/x.md"), "wiki-kernel");
  assert.equal(pageTypeOf({}, "sources/prs/cutlass/PR-1.md"), "source-pr");
  assert.equal(pageTypeOf({}, "sources/blogs/x.md"), "source-blog");
  assert.equal(pageTypeOf({}, "wiki/unknown.md"), "unknown");
});

test("resolveArtifactDir honors an explicit artifact_dir", () => {
  const page = path.join(WIKI_ROOT, "wiki", "kernels", "gated-delta-net.md");
  const result = resolveArtifactDir(page, { artifact_dir: "artifacts/kernels/gated-delta-net" });
  assert.equal(result.rel, "artifacts/kernels/gated-delta-net");
  assert.equal(result.fallback, false);
  assert.ok(result.abs.endsWith(path.join("artifacts", "kernels", "gated-delta-net")));
});
