import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "../scripts/lib/yaml.mjs";
import * as fetcher from "../scripts/fetch-pr-diff.mjs";
import { fixture, put, page, pr, quiet } from "./helpers/asset-fixtures.mjs";

const no_network = () => { throw new Error("unexpected network call"); };

test("strict selection skips nested noise, accepts kernel formats and normalizes Windows paths", () => {
  for (const file of ["src/kernel.CU", "include/a.cuh", "asm/x.ptx", "ops/a.pyx", "vllm/v1/attention/x.py", "backends/x.py", "cutlass_configs/x.json", "src\\kernel.cu"]) assert.equal(fetcher.path_allowed(file), true, file);
  for (const file of ["tests/kernel.cu", "pkg/tests/kernel.cu", "benchmarks/a.cu", "pkg/bench_foo.py", "pkg/docs/a.cu", "pkg/.github/a.cu", "pkg/examples/sub/demo_a.cu", "src/a_test.cpp", "pkg/test_a.py", "src/config.py", "config.json", "src/Makefile"]) assert.equal(fetcher.path_allowed(file), false, file);
  assert.equal(fetcher._suffix("a.b/no_extension"), "");
  assert.equal(fetcher._suffix("a/KERNEL.CUH"), ".cuh");
});

test("two-pass selection uses relaxed Python only when no strict file survives", () => {
  const files = ["vllm/platforms/cuda.py", "src/a.cu", "docs/a.py"].map(filename => ({ filename }));
  assert.deepEqual(fetcher.select_captured_files(files), [[files[1]], false]);
  assert.deepEqual(fetcher.select_captured_files([files[0], files[2]]), [[files[0]], true]);
  assert.deepEqual(fetcher.select_captured_files([files[2]]), [[], false]);
  assert.equal(fetcher.path_allowed_relaxed("pkg/tests/support.py"), false);
});

test("pilot selection spreads four PRs across tracked repos and deterministically pads", () => {
  const ids = [], pages = {};
  for (const repo of ["pytorch", "flashinfer", "vllm", "sglang", "cutlass"]) for (let i = 1; i <= 6; i++) { const id = `pr-${repo}-${i}`; ids.push(id); pages[id] = { repo: `owner/${repo}` }; }
  const pilot = fetcher.select_pilot_ids(ids, pages);
  assert.equal(pilot.length, 20);
  assert.deepEqual(pilot.slice(0, 4), [1, 2, 3, 4].map(n => `pr-cutlass-${n}`));
  for (const repo of ["pytorch", "flashinfer", "vllm", "sglang", "cutlass"]) assert.equal(pilot.filter(id => id.startsWith(`pr-${repo}-`)).length, 4);
  assert.deepEqual(fetcher.select_pilot_ids(["missing", "a", "b"], { a: { repo: "x/vllm" } }), ["a", "missing", "b"]);
});

test("content retrieval supports inline, raw download and git-blob fallbacks", async () => {
  const bytes = Buffer.from([0xff, 0, 0x80]);
  assert.deepEqual(await fetcher.fetch_content_at_sha("a/b", "src/a.cu", "sha", { run_gh: () => JSON.stringify({ type: "file", content: bytes.toString("base64") }) }), bytes);
  assert.deepEqual(await fetcher.fetch_content_at_sha("a/b", "src/a.cu", "sha", { run_gh: () => JSON.stringify({ type: "file", download_url: "https://example/x" }), fetch: () => ({ ok: true, arrayBuffer: () => bytes }) }), bytes);
  const calls = [];
  const result = await fetcher.fetch_content_at_sha("a/b", "src/a.cu", "sha", {
    run_gh(args) { calls.push(args); return calls.length === 1 ? JSON.stringify({ type: "file", download_url: "https://example/x", sha: "blob" }) : bytes; },
    fetch() { throw new Error("offline"); },
  });
  assert.deepEqual(result, bytes); assert.match(calls[1].at(-1), /git\/blobs\/blob$/);
  await assert.rejects(fetcher.fetch_content_at_sha("a/b", "x", "sha", { run_gh: () => '{"type":"dir"}' }), /unexpected response/);
  await assert.rejects(fetcher.fetch_content_at_sha("a/b", "x", "sha", { run_gh: () => '{"type":"file"}' }), /could not fetch/);
});

test("file-list pagination stops on short pages and preserves the 20-page guard", async () => {
  let calls = 0;
  const full = Array.from({ length: 100 }, (_, i) => ({ filename: `src/${i}.cu` }));
  assert.equal((await fetcher.fetch_pr_file_list("a/b", 1, { run_gh: () => JSON.stringify(++calls === 1 ? full : [{ filename: "last.cu" }]) })).length, 101);
  assert.equal(calls, 2); calls = 0;
  assert.equal((await fetcher.fetch_pr_file_list("a/b", 1, { run_gh: () => { calls++; return JSON.stringify(full); } })).length, 2000);
  assert.equal(calls, 20);
});

test("bundle emission pins removed files at one resolved base SHA and records exact hashes", async t => {
  const root = fixture(t), calls = [];
  let base_queries = 0;
  const opts = quiet(root, {
    today: () => "2026-01-02",
    run_gh() { base_queries++; return '{"base":{"sha":"base1234"}}'; },
    fetch_content_at_sha(repo, file, sha) { calls.push([file, sha]); return Buffer.from(`content:${file}:${sha}\n`); },
  });
  const files = [{ filename: "src/a.cu", status: "modified" }, { filename: "src/old.cu", status: "removed" }, { filename: "src/other.cuh", status: "removed" }];
  const [relative, total, count, truncated] = await fetcher.emit_bundle("NVIDIA/DEMO", 1, "pr-demo-1", "merge1234", files, Buffer.from("diff\n"), false, opts);
  const prov = parse(readFileSync(path.join(root, relative, "PROVENANCE.yaml"), "utf8"));
  assert.equal(base_queries, 1); assert.equal(count, 4); assert.equal(truncated, false);
  assert.deepEqual(calls, [["src/a.cu", "merge1234"], ["src/old.cu", "base1234"], ["src/other.cuh", "base1234"]]);
  assert.equal(prov.retrieved_at, "2026-01-02");
  assert.equal(prov.upstream_sha, "merge1234");
  assert.equal(prov.files[2].upstream_sha, "base1234");
  assert.match(prov.files[2].captured_at_base_sha_note, /pre-deletion/);
  assert.equal(total, prov.files.reduce((sum, entry) => {
    const bytes = readFileSync(path.join(root, relative, entry.local_path));
    assert.equal(entry.sha256, fetcher.sha256_bytes(bytes)); return sum + bytes.length;
  }, 0));
  assert.deepEqual(readdirSync(path.dirname(path.join(root, relative))), ["PR-1"]);
});

test("failed fetch leaves the prior complete bundle intact and removes staging", async t => {
  const root = fixture(t), relative = "artifacts/prs/demo/PR-1";
  put(root, `${relative}/old.txt`, "last good bundle");
  const opts = quiet(root, { fetch_content_at_sha(repo, file) { if (file.endsWith("bad.cu")) throw new Error("upstream unavailable"); return Buffer.from("ok"); } });
  await assert.rejects(fetcher.emit_bundle("a/demo", 1, "pr-demo-1", "sha", [{ filename: "src/a.cu" }, { filename: "src/bad.cu" }], Buffer.from("diff"), false, opts), /Aborting PR.*partial bundles/);
  assert.equal(readFileSync(path.join(root, relative, "old.txt"), "utf8"), "last good bundle");
  assert.deepEqual(readdirSync(path.dirname(path.join(root, relative))), ["PR-1"]);
  await assert.rejects(fetcher.emit_bundle("a/demo", 1, "pr-demo-1", "sha", [{ filename: "src/a.cu", status: "removed" }], null, false, { ...opts, run_gh: () => "{}" }), /no base SHA resolved/);
  assert.deepEqual(readdirSync(path.dirname(path.join(root, relative))), ["PR-1"]);
});

test("per-file cap writes a hashed stub and relaxed fallback is documented", async t => {
  const root = fixture(t);
  const [relative, total, count, truncated] = await fetcher.emit_bundle("a/demo", 2, "pr-demo-2", "merge", [{ filename: "platforms/cuda.py" }], null, false, quiet(root, { fetch_content_at_sha: () => Buffer.alloc(fetcher.FILE_SIZE_CAP + 1) }));
  const prov = parse(readFileSync(path.join(root, relative, "PROVENANCE.yaml"), "utf8"));
  assert.equal(count, 1); assert.equal(truncated, false);
  assert.equal(prov.captured_via_relaxed_allowlist, true);
  assert.equal(prov.files[0].size_cap_truncated, true);
  const stub = readFileSync(path.join(root, relative, prov.files[0].local_path));
  assert.match(stub.toString(), /size_cap_truncated/); assert.equal(total, stub.length);
  assert.equal(prov.files[0].sha256, fetcher.sha256_bytes(stub));
});

test("aggregate cap drops the diff then stubs largest key files until the bundle fits", async t => {
  const root = fixture(t), files = Array.from({ length: 6 }, (_, n) => ({ filename: `src/${n}.cu` }));
  const [relative, total, , truncated] = await fetcher.emit_bundle("a/demo", 3, "pr-demo-3", "merge", files, Buffer.alloc(1024), false, quiet(root, { fetch_content_at_sha: () => Buffer.alloc(fetcher.FILE_SIZE_CAP) }));
  assert.ok(total <= fetcher.BUNDLE_SIZE_CAP); assert.equal(truncated, true);
  assert.equal(existsSync(path.join(root, relative, "diff.patch")), false);
  const prov = parse(readFileSync(path.join(root, relative, "PROVENANCE.yaml"), "utf8"));
  assert.equal(prov.size_cap_truncated, true); assert.equal(prov.files.length, 6);
  assert.equal(prov.files.filter(entry => entry.size_cap_truncated).length, 2);
  let actual_size = 0;
  for (const entry of prov.files) {
    const content = readFileSync(path.join(root, relative, entry.local_path)); actual_size += content.length;
    assert.equal(entry.sha256, fetcher.sha256_bytes(content));
  }
  assert.equal(actual_size, total);
});

test("successful atomic replacement removes prior files; dry run never fetches or writes", async t => {
  const root = fixture(t), relative = "artifacts/prs/demo/PR-4";
  put(root, `${relative}/old.txt`, "old");
  const files = [{ filename: "src/new.cu" }];
  await fetcher.emit_bundle("a/demo", 4, "pr-demo-4", "sha", files, null, false, quiet(root, { fetch_content_at_sha: () => Buffer.from("new") }));
  assert.equal(existsSync(path.join(root, relative, "old.txt")), false);
  const before = readdirSync(path.join(root, relative));
  await fetcher.emit_bundle("a/demo", 4, "pr-demo-4", "sha", files, null, true, quiet(root, { fetch_content_at_sha: no_network, run_gh: no_network }));
  assert.deepEqual(readdirSync(path.join(root, relative)), before);
});

test("frontmatter update preserves body and removes banned peer pointers", t => {
  const root = fixture(t), body = "# Body\n\nText.\n";
  const file = page(root, "sources/prs/demo/PR-1.md", { id: "pr-demo-1", diff_path: "old", code_path: "old", patch_path: "old", key_file_path: "old" }, body);
  assert.equal(fetcher.update_pr_page(file, readFileSync(file, "utf8"), "artifacts/prs/demo/PR-1"), true);
  const text = readFileSync(file, "utf8");
  assert.ok(text.endsWith(body)); assert.match(text, /artifact_dir: artifacts\/prs\/demo\/PR-1/); assert.doesNotMatch(text, /(?:diff|code|patch|key_file)_path/);
  assert.equal(fetcher.update_pr_page(file, "no frontmatter", "ignored"), false);
  assert.equal(fetcher.update_pr_page(file, "---\nx: [\n---\nbody\n", "ignored"), false);
});

function corpus(t, count = 2) {
  const root = fixture(t);
  for (let n = 1; n <= count; n++) pr(root, n, n === 2 ? { changed_paths: [] } : {});
  put(root, "data/core-prs.yaml", `prs:\n${Array.from({ length: count }, (_, i) => `- id: pr-demo-${i + 1}\n`).join("")}`);
  return root;
}

test("dry-run CLI counts previews including absent paths and --dry-run-live takes precedence", async t => {
  const root = corpus(t);
  assert.equal(await fetcher.main(["--all", "--dry-run"], quiet(root, { run_gh: no_network, fetch_pr_file_list: no_network })), 0);
  assert.equal(existsSync(path.join(root, "artifacts")), false);
  let live_calls = 0;
  assert.equal(await fetcher.main(["--ids", "pr-demo-1", "--dry-run", "--dry-run-live", "--max-pr=1"], quiet(root, { fetch_pr_file_list() { live_calls++; return [{ filename: "src/x.cu" }]; }, run_gh: no_network })), 0);
  assert.equal(live_calls, 1);
  assert.equal(existsSync(path.join(root, "artifacts")), false);
});

test("partial pilot exits 1, leaves budget untouched and does not update a failed page", async t => {
  const root = corpus(t);
  put(root, "data/phase3-size-budget.yaml", "prior-budget\n");
  const before = readFileSync(path.join(root, "sources/prs/demo/PR-2.md"));
  const code = await fetcher.main(["--pilot"], quiet(root, {
    fetch_pr_file_list: () => [{ filename: "src/a.cu" }], fetch_pr_whole_diff: () => Buffer.from("diff"),
    fetch_content_at_sha(repo, file, sha) { return Buffer.from(sha); },
    async emit_bundle(...args) { if (args[1] === 2) throw new Error("offline"); return fetcher.emit_bundle(...args); },
  }));
  assert.equal(code, 1);
  assert.equal(readFileSync(path.join(root, "data/phase3-size-budget.yaml"), "utf8"), "prior-budget\n");
  assert.deepEqual(readFileSync(path.join(root, "sources/prs/demo/PR-2.md")), before);
  assert.match(readFileSync(path.join(root, "sources/prs/demo/PR-1.md"), "utf8"), /artifact_dir:/);
});

test("successful pilot tolerates diff failure, writes budget and updates artifact_dir", async t => {
  const root = corpus(t, 1);
  const code = await fetcher.main(["--pilot"], quiet(root, { fetch_pr_file_list: () => [{ filename: "src/a.cu" }], fetch_pr_whole_diff() { throw new Error("diff unavailable"); }, fetch_content_at_sha: () => Buffer.from("code") }));
  assert.equal(code, 0);
  const budget = parse(readFileSync(path.join(root, "data/phase3-size-budget.yaml"), "utf8"));
  assert.equal(budget.pilot_size, 1); assert.equal(budget.pilot_total_bytes, 4); assert.equal(budget.avg_bundle_bytes, 4);
  assert.equal(budget.core_prs_total, 1); assert.equal(budget.active_ceiling_mib, 25);
});

test("CLI invocation and requested target errors remain nonzero", async t => {
  const root = corpus(t, 1);
  for (const argv of [[], ["--ids"], ["--all", "--max-pr", "bad"], ["--unknown"]]) assert.equal(await fetcher.main(argv, quiet(root)), 2);
  assert.equal(await fetcher.main(["--ids=pr-missing-1", "--dry-run"], quiet(root)), 1);
  assert.equal(await fetcher.main(["--all", "--dry-run-live"], quiet(root, { fetch_pr_file_list() { throw new Error("offline"); } })), 1);
  assert.throws(() => fetcher.load_core_prs(path.join(root, "missing")), /missing data\/core-prs.yaml/);
});
