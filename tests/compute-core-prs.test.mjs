import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "../scripts/lib/yaml.mjs";
import * as core from "../scripts/compute-core-prs.mjs";
import { fixture, put, page, pr } from "./helpers/asset-fixtures.mjs";

const script = fileURLToPath(new URL("../scripts/compute-core-prs.mjs", import.meta.url));

test("Python fnmatch semantics preserve slash matching, depth, case and classes", () => {
  for (const [value, glob, expected] of [
    ["a/b/c.py", "*.py", true], ["tests/a.py", "**/tests/**", false], ["x/tests/a.py", "**/tests/**", true],
    ["a/b.cu", "a/*.cu", true], ["A.cu", "a.cu", false], ["x", "[!a-w]", true],
    ["]", "[]]", true], ["a", "[abc]", true], ["b", "[!a]", true], ["[a", "[a", true],
    ["a\n", "a", false], ["x/a.cu", "x/?.cu", true],
  ]) assert.equal(core._fnmatch(value, glob), expected, `${value} / ${glob}`);
});

test("frontmatter handles CRLF, invalid YAML, absent delimiters and unreadable files", t => {
  const root = fixture(t);
  const file = put(root, "a.md", "---\r\nid: a\r\n---\r\nbody\r\n");
  assert.deepEqual(core.extract_frontmatter(file), [{ id: "a" }, "body\n"]);
  assert.deepEqual(core.extract_frontmatter(put(root, "bad.md", "---\nx: [\n---\nbody\n")), [null, "body\n"]);
  assert.deepEqual(core.extract_frontmatter(put(root, "plain.md", "hello\n")), [null, "hello\n"]);
  assert.deepEqual(core.extract_frontmatter(path.join(root, "missing")), [null, ""]);
});

test("CuTe policy requires surviving kernel authorship and separates weak examples from strong paths", () => {
  assert.deepEqual(core.apply_cute_dsl_policy({}, { changed_paths: ["include/cute/a.hpp"] }), [true, null]);
  assert.deepEqual(core.apply_cute_dsl_policy({}, { changed_paths: ["examples/90/a.cu"] }), [false, "not a cute-dsl PR"]);
  assert.equal(core.apply_cute_dsl_policy({}, { languages: ["cute-dsl"], changed_paths: ["examples/90/a.cu"] })[0], true);
  assert.match(core.apply_cute_dsl_policy({}, { tags: ["cute-dsl"], changed_paths: ["src/dispatch.py"] })[1], /affinity only/);
  assert.match(core.apply_cute_dsl_policy({}, { tags: ["cute-dsl"], changed_paths: ["tests/test_cutedsl.py"] })[1], /empty bundle/);
  assert.match(core.apply_cute_dsl_policy({}, { tags: ["cute-dsl"], changed_paths: ["tests/test_cutedsl.py", "src/dispatch.py"] })[1], /no kernel/);
  assert.deepEqual(core.apply_cute_dsl_policy({ "cute-dsl": { skip_criteria: [{ changed_paths_match_only: ["docs/**"] }] } }, { languages: ["cute-dsl"], changed_paths: ["docs/cute.md"] }), [false, "documentation-only CuTe DSL PR"]);
  assert.equal(core.all_paths_would_be_skipped_by_fetch([]), false);
});

test("Triton policy preserves vendor, Hopper, runtime, noise gates and all three subscopes", () => {
  const base = { languages: ["triton"], architectures: ["sm100"], changed_paths: ["src/triton_attn.py"] };
  assert.deepEqual(core.apply_triton_policy({}, base), [true, null]);
  assert.deepEqual(core.apply_triton_policy({}, { ...base, architectures: ["sm90", "sm90a"] }), [false, "pure Hopper Triton (no SM100 relevance)"]);
  assert.match(core.apply_triton_policy({}, { ...base, title: "[Intel GPU] update" })[1], /non-Blackwell vendor/);
  assert.deepEqual(core.apply_triton_policy({}, { ...base, changed_paths: ["pkg/config/a.py", "pkg/__init__.py"] }), [false, "runtime-config-only Triton PR"]);
  assert.match(core.apply_triton_policy({}, { ...base, symptoms: ["memory-bound"], changed_paths: ["benchmark/triton_kernel.py"] })[1], /empty bundle/);
  assert.deepEqual(core.apply_triton_policy({}, { languages: ["triton"], symptoms: ["low-sm-utilization"] }), [true, null]);
  for (const title of ["Fall back to triton MOE", "fall-back", "falls back", "falling back", "cutlass is unavailable", "sm100 path"]) assert.equal(core.apply_triton_policy({}, { languages: ["triton"], title })[0], true);
  assert.equal(core.apply_triton_policy({}, { languages: ["triton"] })[0], false);
});

test("universe candidates are sorted and include skipped strong paths without including unrelated PRs", () => {
  const entries = core.build_cute_universe({}, {
    z: { tags: ["cute-dsl"], changed_paths: ["tests/a.py"] },
    a: { changed_paths: ["include/cute/x.hpp"] },
    other: { changed_paths: ["examples/90/a.cu"] },
  });
  assert.deepEqual(entries.map(e => [e.id, e.captured]), [["a", true], ["z", false]]);
  assert.deepEqual(core.filter_candidates(entries, e => e.captured), [{ id: "a", captured: true }]);
});

test("manifest derivation uses structured contest references, inclusion precedence, exclusions and existing IDs", t => {
  const root = fixture(t);
  pr(root, 1, { languages: ["cute-dsl"], changed_paths: ["cute/a.py"] });
  pr(root, 2, { tags: ["cute-dsl"], changed_paths: ["cute/b.py"] });
  pr(root, 3, { tags: ["cute-dsl"], changed_paths: ["cute/c.py"] });
  pr(root, 4, { languages: ["triton"], symptoms: ["memory-bound"] });
  pr(root, 5);
  pr(root, 6);
  pr(root, 7);
  page(root, "wiki/a.md", { sources: ["pr-demo-1", "pr-demo-6", "pr-missing-1", "blog-a"] });
  page(root, "sources/contests/c/a.md", { referenced_prs: ["pr-demo-1", "pr-demo-2", 42] }, "Prose mentions pr-demo-7, which is not an inclusion.\n");
  put(root, "data/core-prs-allowlist.yaml", core.dump_sorted({ additions: [{ pr: "pr-demo-5" }, { pr: "pr-demo-1" }, { pr: "pr-missing-2" }], exclusions: [{ pr: "pr-demo-6" }] }));
  const bytes = core.compute_manifests(root);
  assert.deepEqual(bytes, core.compute_manifests(root));
  const doc = parse(bytes["core-prs.yaml"].toString());
  assert.deepEqual(doc.prs, [
    { id: "pr-demo-1", source_of_inclusion: "wiki-graph-closure" },
    { id: "pr-demo-2", source_of_inclusion: "contest-reference" },
    { id: "pr-demo-3", source_of_inclusion: "cute-dsl-tutorial" },
    { id: "pr-demo-4", source_of_inclusion: "triton-in-policy" },
    { id: "pr-demo-5", source_of_inclusion: "allowlist" },
  ]);
  assert.equal(doc.checksum_sha256, core.compute_sha256_of_text(core.dump_sorted(doc.prs)));
  assert.ok(Object.values(bytes).every(Buffer.isBuffer));
  assert.deepEqual([...core.contest_referenced_prs(root)], ["pr-demo-1", "pr-demo-2"]);
  assert.equal(core.load_all_prs(root)["pr-demo-1"]._path, "sources/prs/demo/PR-1.md");
});

test("missing policy errors; malformed allowlist collections are ignored", t => {
  const root = fixture(t);
  put(root, "data/core-prs-allowlist.yaml", "additions: wrong\nexclusions: wrong\n");
  assert.equal(parse(core.compute_manifests(root)["core-prs.yaml"].toString()).total_captured, 0);
  assert.throws(() => core.compute_manifests(path.join(root, "absent")), /inclusion-policy.yaml not found/);
});

test("current corpus preserves semantic manifests and Python's prs checksum", () => {
  for (const [name, bytes] of Object.entries(core.compute_manifests())) {
    const actual = parse(bytes.toString()), existing = parse(readFileSync(path.join(core.DATA, name), "utf8"));
    assert.deepEqual(actual, { ...existing, generated_by: "scripts/compute-core-prs.mjs" });
  }
});

test("CLI root override works outside the corpus and stdout preserves marker ordering", t => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [script, "--stdout"], { cwd: os.tmpdir(), env: { ...process.env, BLACKWELL_WIKI_ROOT: root }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([...result.stdout.matchAll(/^### FILE: (.+)$/gm)].map(m => m[1]), ["core-prs.yaml", "cute-dsl-universe.yaml", "triton-universe.yaml"]);
  assert.ok(result.stdout.startsWith("### FILE: core-prs.yaml\n## Auto-generated"));
  const output = path.join(root, "output");
  const writer = spawnSync(process.execPath, [script, "--output-dir", output], { env: { ...process.env, BLACKWELL_WIKI_ROOT: root }, encoding: "utf8" });
  assert.equal(writer.status, 0, writer.stderr);
  assert.deepEqual(readFileSync(path.join(output, "core-prs.yaml")), core.compute_manifests(root)["core-prs.yaml"]);
});

test("importing the migrated local tools has no CLI effects", () => {
  const modules = ["compute-core-prs", "fetch-pr-diff", "verify-core-prs", "verify-verbatim"].map(name => new URL(`../scripts/${name}.mjs`, import.meta.url).href);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await Promise.all(${JSON.stringify(modules)}.map(url => import(url)))`], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
