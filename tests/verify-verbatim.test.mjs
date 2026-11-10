import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as verify from "../scripts/verify-verbatim.mjs";
import { dump_sorted } from "../scripts/compute-core-prs.mjs";
import { fixture, put, quiet } from "./helpers/asset-fixtures.mjs";

const baseline = Buffer.from("diff --git a/a.c b/a.c\nindex 3053d4b98d9..f06dc141324 100644\n--- a/a.c\n+++ b/a.c\n@@ -1 +1 @@\n-old\n+new\n");

test("ported: Git object abbreviation length is not semantic", () => {
  const upstream = Buffer.from(baseline.toString().replace("3053d4b98d9..f06dc141324", "3053d4b98d9f..f06dc1413244"));
  assert.notDeepEqual(baseline, upstream);
  assert.deepEqual(verify.canonicalize_upstream_patch(baseline), verify.canonicalize_upstream_patch(upstream));
});
test("ported: patch hunk changes remain discriminating", () => {
  const corrupted = Buffer.from(baseline.toString().replace("+new\n", "+wrong\n"));
  assert.notDeepEqual(verify.canonicalize_upstream_patch(baseline), verify.canonicalize_upstream_patch(corrupted));
});
test("ported: file modes remain discriminating", () => {
  assert.notDeepEqual(verify.canonicalize_upstream_patch(Buffer.from("index abcdef1..abcdef2 100644\n")), verify.canonicalize_upstream_patch(Buffer.from("index abcdef1..abcdef2 100755\n")));
});
test("patch canonicalization preserves arbitrary bytes, CRLF, hunks and non-index lines", () => {
  const bytes = Buffer.concat([Buffer.from("index aa..bb 100644\r\n+index aa..bb\n"), Buffer.from([0xff, 0x80, 0x00])]);
  const expected = Buffer.concat([Buffer.from("index <OLD>..<NEW> 100644\r\n+index aa..bb\n"), Buffer.from([0xff, 0x80, 0x00])]);
  assert.deepEqual(verify.canonicalize_upstream_patch(bytes), expected);
});

test("PR number resolution preserves directory, ID, URL, filename precedence", () => {
  const prov = { source_pr_id: "pr-some-repo-22", origin_url: "https://github.com/a/b/pull/33" };
  assert.equal(verify._resolve_pr_number("/x/PR-11", prov, "PR_44.patch"), "11");
  assert.equal(verify._resolve_pr_number("/x/bundle", prov, "PR_44.patch"), "22");
  assert.equal(verify._resolve_pr_number("/x/bundle", { origin_url: prov.origin_url }, "PR_44.patch"), "33");
  assert.equal(verify._resolve_pr_number("/x/bundle", {}, "some/PR_44.patch"), "44");
  assert.equal(verify._resolve_pr_number("/x/bundle", {}, "diff.patch"), null);
});

test("gh errors distinguish missing CLI, network, auth and rate limit from upstream rejection", () => {
  const fails = (stderr, code = 1) => () => { throw Object.assign(new Error("failed"), { code, stderr: Buffer.from(stderr) }); };
  assert.throws(() => verify.run_gh([], { exec: fails("", "ENOENT") }), verify.EnvError);
  for (const msg of ["error connecting to api.github.com", "Bad credentials", "API rate limit exceeded", "To get started, run: gh auth login"]) assert.throws(() => verify.run_gh(["api", "x"], { exec: fails(msg) }), verify.EnvError);
  assert.throws(() => verify.run_gh([], { exec: fails("HTTP 404: Not Found") }), error => !(error instanceof verify.EnvError) && /Not Found/.test(error.message));
});

test("patch fetching accepts merge prefixes and rejects matching head-only prefixes", async () => {
  const calls = [];
  const opts = { run_gh(args) { calls.push(args); return args[0] === "api" ? JSON.stringify({ merge_commit_sha: "abcdef123456", head: { sha: "stale123456" } }) : baseline; } };
  assert.deepEqual(await verify.fetch_upstream_patch("a/b", 7, "abcdef12", opts), baseline);
  assert.equal(calls.length, 2);
  await assert.rejects(verify.fetch_upstream_patch("a/b", 7, "stale", opts), /head.sha=.*not accepted/);
  assert.equal(calls.length, 3);
});

test("verbatim fetch decodes base64 and rejects absent content", async () => {
  const bytes = Buffer.from([0xff, 0, 1, 2]);
  assert.deepEqual(await verify.fetch_verbatim("a/b", "sha", "x.cu", { run_gh: () => JSON.stringify({ content: bytes.toString("base64") }) }), bytes);
  await assert.rejects(verify.fetch_verbatim("a/b", "sha", "x.cu", { run_gh: () => "{}" }), /no content in response/);
});

function bundle(t, files, extra = {}) {
  const root = fixture(t), relative = "artifacts/prs/demo/PR-7", dir = path.join(root, relative);
  put(root, `${relative}/PROVENANCE.yaml`, dump_sorted({ upstream_repo: "a/b", upstream_sha: "merge", files, ...extra }));
  return { root, relative, dir };
}

test("bundle verification honors per-file upstream overrides and skips truncated/non-verbatim entries", async t => {
  const { root, relative, dir } = bundle(t, [
    { local_path: "x.cu", mode: "verbatim", upstream_path: "src/x.cu", upstream_repo: "other/repo", upstream_sha: "base" },
    { local_path: "stub.cu", mode: "verbatim", size_cap_truncated: true },
    { mode: "adapted", local_path: "missing.cu" }, "invalid", null,
  ]);
  put(root, `${relative}/x.cu`, Buffer.from([0xff, 0]));
  const calls = [];
  const result = await verify.verify_bundle(dir, { root, fetch_verbatim(...args) { calls.push(args.slice(0, 3)); return Buffer.from([0xff, 0]); } });
  assert.deepEqual(result, [[], []]);
  assert.deepEqual(calls, [["other/repo", "base", "src/x.cu"]]);
});

test("bundle patch verification canonicalizes IDs but detects changed bytes", async t => {
  const { root, relative, dir } = bundle(t, [{ local_path: "diff.patch", mode: "upstream-patch" }]);
  put(root, `${relative}/diff.patch`, baseline);
  const fetch_upstream_patch = () => Buffer.from(baseline.toString().replace("3053d4b98d9", "3053d4b98d9f"));
  assert.deepEqual(await verify.verify_bundle(dir, { root, fetch_upstream_patch }), [[], []]);
  const [errors] = await verify.verify_bundle(dir, { root, fetch_upstream_patch: () => Buffer.from(baseline.toString().replace("+new", "+wrong")) });
  assert.match(errors[0], /canonicalized upstream-patch mismatch/);
});

test("bundle errors cover missing provenance, bad YAML, absent local bytes, metadata and fetch failures", async t => {
  const { root, relative, dir } = bundle(t, [
    { local_path: "missing", mode: "verbatim" },
    { local_path: "x.cu", mode: "verbatim" },
    { local_path: "diff.patch", mode: "upstream-patch" },
  ], { upstream_sha: null });
  put(root, `${relative}/x.cu`, "x"); put(root, `${relative}/diff.patch`, "diff");
  const [errors] = await verify.verify_bundle(dir, { root });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /local file missing/);
  assert.match(errors[1], /verbatim mode requires/);
  assert.match(errors[2], /requires upstream_sha/);
  assert.match((await verify.verify_bundle(path.join(root, "other"), { root }))[0][0], /missing PROVENANCE/);
  put(root, `${relative}/PROVENANCE.yaml`, "files: [\n");
  assert.match((await verify.verify_bundle(dir, { root }))[0][0], /YAML parse error/);
});

test("bundle fetch errors keep environment failures separate from content mismatches", async t => {
  const { root, relative, dir } = bundle(t, [{ local_path: "x.cu", mode: "verbatim", upstream_path: "x.cu" }]);
  put(root, `${relative}/x.cu`, "x");
  const [errors, env] = await verify.verify_bundle(dir, { root, fetch_verbatim() { throw new verify.EnvError("offline"); } });
  assert.equal(errors.length, 0); assert.match(env[0], /environment failure: offline/);
  const [content, no_env] = await verify.verify_bundle(dir, { root, fetch_verbatim() { throw new Error("not found"); } });
  assert.match(content[0], /upstream fetch failed: not found/); assert.equal(no_env.length, 0);
});

test("CLI default warns, strict fails, and environment failures take precedence", async t => {
  const { root, dir } = bundle(t, []);
  const opts = quiet(root, { verify_bundle: () => [["mismatch"], []] });
  // main prints diagnostics via console; suppress only within this test context.
  t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {});
  assert.equal(await verify.main(["--bundle", dir], opts), 0);
  assert.equal(await verify.main(["--strict", "--bundle", dir], opts), 1);
  assert.equal(await verify.main(["--strict"], { ...opts, verify_bundle: () => [["mismatch"], ["offline"]] }), 2);
  assert.equal(await verify.main(["--bad"], opts), 2);
  assert.ok(readFileSync(path.join(dir, "PROVENANCE.yaml")).length);
});
