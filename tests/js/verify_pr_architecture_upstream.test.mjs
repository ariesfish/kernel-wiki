import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import * as verify from "../../scripts/verify_pr_architecture_upstream.mjs";
import { EnvError } from "../../scripts/verify_verbatim.mjs";
import { upstream_files_sha256, device_code_pattern_sha256, python_dsl_pattern_sha256 } from "../../scripts/pr_policy.mjs";
import { fixture, page, put, quiet } from "./assets-fixtures.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const api_rows = count => Array.from({ length: count }, (_, i) => ({ filename: `src/${i}.h`, patch: "", status: "modified" }));
function capped_options(pull, full) {
  return {
    github_json(endpoint) {
      if (!endpoint.includes("/files?")) return pull;
      const page = Number(/page=(\d+)$/.exec(endpoint)[1]);
      return page <= 30 ? api_rows(100).map((item, i) => ({ ...item, filename: `src/${page}-${i}.h` })) : [];
    },
    fetch_full_diff_files: () => full,
  };
}

test("ported: documented 3000-file cap preserves authoritative total and full evidence", async () => {
  const full = api_rows(3750);
  const [pull, files, complete, evidence] = await verify.fetch_upstream("example/project", 9, capped_options({ changed_files: 3750 }, full));
  assert.equal(pull.changed_files, 3750); assert.equal(files.length, 3000); assert.equal(complete, false); assert.equal(evidence.length, 3750);
});

test("ported: capped tail is evaluated with the full scope policy", () => {
  const listed = Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md`, patch: "", status: "modified" }));
  const full = [...listed, { filename: "src/tail_kernel.h", status: "added", patch: "+CUTLASS_DEVICE void tail_kernel();" }];
  const expected = verify.derive_upstream_record({ title: "Kernel update", body: "", changed_files: 3001 }, listed, false, full);
  assert.equal(expected.retain, true); assert.equal(expected.scope_rule, "device-code-signal"); assert.deepEqual(expected.scope_paths, ["src/tail_kernel.h"]);
  assert.equal(expected.changed_files_evidence_complete, true); assert.equal(expected.changed_files_evidence_count, 3001);
  assert.equal(expected.changed_files_enumerated_count, 3000); assert.equal(expected.changed_files_count, 3001);
  assert.equal(expected.changed_paths_complete, false); assert.ok(expected.changed_paths.includes("src/tail_kernel.h"));
  assert.equal(expected.upstream_files_sha256, upstream_files_sha256(full));
});

test("ported: complete CUDA evidence distinguishes device implementation from host code", async () => {
  const files = [{ filename: "csrc/device.cu", status: "modified", patch: "+update_dispatch();" }, { filename: "csrc/host.cu", status: "modified", patch: '+m.def("op", &op);' }];
  const payload = url => Buffer.from(url.endsWith("device.cu") ? "__global__ void kernel() {}" : "void register_op() {}");
  const actual = await verify.attach_complete_cuda_evidence("example/project", "a".repeat(40), files, { _fetch_bytes: payload });
  assert.equal(actual, files); assert.equal(actual[0].complete_file_device_signal, true); assert.equal(actual[1].complete_file_device_signal, false);
  assert.equal(actual[0].complete_file_sha256, hash(payload("device.cu"))); assert.equal(actual[0].complete_file_device_pattern_sha256, device_code_pattern_sha256());
  assert.equal(verify.derive_upstream_record({ title: "Update", body: "", changed_files: 1 }, [actual[0]]).retain, true);
  assert.equal(verify.derive_upstream_record({ title: "Update", body: "", changed_files: 1 }, [actual[1]]).retain, false);
});

test("ported: complete Python evidence distinguishes DSL from host tuning code", async () => {
  const files = [{ filename: "ops/kernel.py", status: "modified", patch: "+num_warps = 8" }, { filename: "layers/config.py", status: "modified", patch: "+num_blocks = (n + block_n - 1) // block_n" }];
  const payload = url => Buffer.from(url.endsWith("kernel.py") ? "@triton.jit\ndef kernel(x):\n    return tl.load(x)\n" : "def blocks(n, block_n):\n    return (n + block_n - 1) // block_n\n");
  const actual = await verify.attach_complete_file_evidence("example/project", "a".repeat(40), files, { _fetch_bytes: payload });
  assert.equal(actual[0].complete_file_python_dsl_signal, true); assert.deepEqual(actual[0].complete_file_python_dsl_languages, ["triton"]); assert.equal(actual[1].complete_file_python_dsl_signal, false);
  assert.equal(actual[0].complete_file_python_dsl_sha256, hash(payload("kernel.py"))); assert.equal(actual[0].complete_file_python_dsl_pattern_sha256, python_dsl_pattern_sha256());
  assert.equal(verify.derive_upstream_record({ title: "Update", body: "", changed_files: 1 }, [actual[0]]).retain, true);
  assert.equal(verify.derive_upstream_record({ title: "Update", body: "", changed_files: 1 }, [actual[1]]).retain, false);
});

function local_page(expected) {
  return {
    title: expected.title, architectures: expected.architectures, architecture_disposition: expected.architecture_disposition, architecture_evidence: expected.architecture_evidence,
    upstream_body_sha256: expected.upstream_body_sha256, upstream_files_sha256: expected.upstream_files_sha256,
    changed_files_count: expected.changed_files_count, changed_paths: expected.changed_paths, changed_paths_complete: expected.changed_paths_complete,
    scope_disposition: "retained", scope_evidence: { rule: expected.scope_rule, paths: expected.scope_paths, ...(expected.scope_path_source ? { path_source: expected.scope_path_source } : {}) },
    ...(Object.hasOwn(expected, "changed_files_evidence_count") ? Object.fromEntries(["changed_files_evidence_count", "changed_files_evidence_complete", "changed_files_evidence_method", "changed_files_evidence_receipt", "changed_files_enumerated_count", "changed_files_listing_complete"].map(field => [field, expected[field]])) : {}),
    ...expected.metadata,
  };
}
function retained_record() {
  return verify.derive_upstream_record({ title: "Add SM75 MMA support", body: "Turing kernel." }, [{ filename: "src/mma_sm75.cu", status: "added", patch: "+__global__ void mma_sm75() {}", additions: 1, deletions: 0 }]);
}

test("ported: local joint fabrication fails the independent upstream record", () => {
  const expected = retained_record(), fm = { ...local_page(expected), architectures: ["sm100"], architecture_disposition: "exact", architecture_evidence: [{ architecture: "sm100" }] };
  assert.ok(verify.compare_local_page("fixture", fm, expected).some(error => error.includes("architectures")));
});

test("ported: removed upstream record rejects an existing local page", () => {
  const expected = verify.derive_upstream_record({ title: "Add host UVA view", body: "" }, [{ filename: "csrc/view.cu", status: "added", patch: "+void view() { cudaHostGetDevicePointer(0, 0, 0); }", additions: 1, deletions: 0 }]);
  assert.equal(expected.retain, false); assert.equal(verify.compare_local_page("fixture", {}, expected).length, 1);
  assert.deepEqual(verify.compare_local_page("fixture", null, expected), []);
});

test("pagination mismatch, non-list, full-diff mismatch and missing immutable SHA are evidence errors", async () => {
  await assert.rejects(verify.fetch_upstream("a/b", 1, { github_json: endpoint => endpoint.includes("/files?") ? [] : { changed_files: 1 } }), /incomplete GitHub file pagination/);
  await assert.rejects(verify.fetch_upstream("a/b", 1, { github_json: endpoint => endpoint.includes("/files?") ? {} : {} }), /response is not a list/);
  await assert.rejects(verify.fetch_upstream("a/b", 1, capped_options({ changed_files: 3750 }, api_rows(3749))), /full pull diff count mismatch/);
  await assert.rejects(verify.fetch_upstream("a/b", 1, { github_json: endpoint => endpoint.includes("/files?") ? [{ filename: "src/host.cu", patch: "+dispatch();" }] : { changed_files: 1, head: { sha: "main" } } }), /missing immutable pull head SHA/);
});

test("complete evidence uses immutable SHA, escapes paths and excludes nonimplementation and distributed files", async () => {
  const paths = ["src/host name(1).cu", "tests/test.cu", "src/all_reduce.cu"];
  const files = paths.map(filename => ({ filename, patch: "+dispatch();", status: "modified" })), urls = [];
  await verify.attach_complete_file_evidence("a/b", "f".repeat(40), files, { _fetch_bytes(url) { urls.push(url); return Buffer.from("__global__ void kernel() {}\n"); } });
  assert.deepEqual(urls, [`https://raw.githubusercontent.com/a/b/${"f".repeat(40)}/src/host%20name%281%29.cu`]);
  assert.equal(files[1].complete_file_evidence_complete, undefined); assert.equal(files[2].complete_file_evidence_complete, undefined);
});

test("complete evidence concurrency is bounded at 16 and propagates environment failures", async () => {
  const files = Array.from({ length: 35 }, (_, i) => ({ filename: `src/${i}.cu`, patch: "+dispatch();" }));
  let active = 0, peak = 0;
  await verify.attach_complete_file_evidence("a/b", "f".repeat(40), files, { async _fetch_bytes() { peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return Buffer.from("host"); } });
  assert.equal(peak, 16); assert.equal(active, 0);
  await assert.rejects(verify.attach_complete_file_evidence("a/b", "f".repeat(40), files, { _fetch_bytes() { throw new EnvError("offline"); } }), EnvError);
});

test("upstream hashes retain raw body bytes and discriminate file evidence changes", () => {
  const files = [{ filename: "src/a.cuh", patch: "+device", status: "modified" }];
  const record = verify.derive_upstream_record({ body: "你好\r\n" }, files);
  assert.equal(record.upstream_body_sha256, hash(Buffer.from("你好\r\n")));
  assert.notEqual(record.upstream_files_sha256, verify.derive_upstream_record({}, [{ ...files[0], patch: "+different" }]).upstream_files_sha256);
});

test("page comparison accepts matching metadata and flags missing pages, receipt fields and scope source", () => {
  const expected = retained_record(), fm = local_page(expected);
  assert.deepEqual(verify.compare_local_page("fixture", fm, expected), []);
  assert.match(verify.compare_local_page("fixture", null, expected)[0], /local page is missing/);
  const extended = { ...expected, changed_files_evidence_count: 1, changed_files_evidence_complete: true, changed_files_evidence_method: "github-pull-diff", changed_files_evidence_receipt: "audit/pr-file-cap-reconstruction.json", scope_path_source: "github-pull-diff" };
  const matching = local_page(extended);
  assert.deepEqual(verify.compare_local_page("fixture", matching, extended), []);
  matching.changed_files_evidence_count = 0; matching.scope_evidence.path_source = null; matching.tags = ["fabricated"];
  const errors = verify.compare_local_page("fixture", matching, extended);
  for (const field of ["changed_files_evidence_count", "scope_evidence.path_source", "tags"]) assert.ok(errors.some(error => error.endsWith(field)));
});

test("raw HTTP and gh errors distinguish connectivity/auth/rate limits from evidence rejection", async () => {
  await assert.rejects(verify._fetch_bytes("https://example/x", { fetch() { throw new Error("offline"); } }), EnvError);
  for (const status of [401, 403, 408, 429, 500, 503]) await assert.rejects(verify._fetch_bytes("https://example/x", { fetch: () => ({ ok: false, status }) }), EnvError);
  await assert.rejects(verify._fetch_bytes("https://example/x", { fetch: () => ({ ok: false, status: 404 }) }), error => !(error instanceof EnvError) && /404/.test(error.message));
  await assert.rejects(verify.github_json("x", { run_gh() { throw new EnvError("rate limit"); } }), EnvError);
});

test("full diff uses native fetch and the policy parser", async () => {
  const files = await verify.fetch_full_diff_files("a/b", 1, { _fetch_bytes: () => Buffer.from("diff --git a/src/a.cu b/src/a.cu\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.cu\n@@ -0,0 +1 @@\n+__global__ void kernel() {}\n") });
  assert.equal(files.length, 1); assert.equal(files[0].filename, "src/a.cu"); assert.equal(files[0].status, "added");
});

test("frontmatter parses CRLF and rejects absent or malformed YAML", t => {
  const root = fixture(t);
  assert.deepEqual(verify.frontmatter(put(root, "a.md", "---\r\nid: a\r\n---\r\nbody\r\n")), { id: "a" });
  assert.throws(() => verify.frontmatter(put(root, "plain.md", "body\n")), /missing frontmatter/);
  assert.throws(() => verify.frontmatter(put(root, "bad.md", "---\nx: [\n---\nbody\n")));
});

test("main gives environment errors precedence and treats policy mismatches as content failures", async t => {
  const root = fixture(t), samples = [["demo/PR-1.md", "a/b", 1], ["demo/PR-2.md", "a/b", 2]];
  const files = [{ filename: "src/a.cuh", patch: "+device" }], pull = { title: "Update", changed_files: 1 };
  const opts = quiet(root, { samples, fetch_upstream: () => [pull, files, true, files] });
  assert.equal(await verify.main([], opts), 1);
  assert.equal(await verify.main([], { ...opts, fetch_upstream(repo, number) { if (number === 2) throw new EnvError("offline"); return [pull, files, true, files]; } }), 2);
  const expected = verify.derive_upstream_record(pull, files);
  for (const [relative] of samples) page(root, `sources/prs/${relative}`, local_page(expected));
  assert.equal(await verify.main([], opts), 0);
  page(root, "sources/prs/demo/PR-1.md", { ...local_page(expected), architectures: ["sm100"] });
  assert.equal(await verify.main([], opts), 1);
  assert.equal(await verify.main(["--unknown"], opts), 2);
});

test("architecture module imports silently without running the online gate", () => {
  const url = new URL("../../scripts/verify_pr_architecture_upstream.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});
