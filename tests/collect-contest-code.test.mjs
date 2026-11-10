import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as C from "../scripts/collect-contest-code.mjs";
import { parse, stringify } from "../scripts/lib/yaml.mjs";
import { import_in_root, put, run, snapshot, temp_root } from "./helpers/maintenance-fixtures.mjs";

const page_path = "sources/contests/contest/problem.md";
const bundle_path = "artifacts/contests/contest/problem/submissions/rank-1-author";
const original_sub = { rank: 1, participant: "Author", submission_truth: "official-submission", code_path: `${bundle_path}/old.cu` };
function fixture(t) {
  const root = temp_root(t);
  const page = put(root, page_path, `---\n${stringify({ id: "contest-curator-id", submissions: [original_sub] })}---\n\n# Body\n\nKeep this prose unchanged.\n`);
  put(root, `${bundle_path}/old.cu`, "old bytes\n");
  put(root, `${bundle_path}/nested/old.cuh`, "old nested bytes\n");
  put(root, "artifacts/blogs/blog/code/01-baseline.cu", "baseline();\n");
  put(root, "artifacts/blogs/blog/code/02-winner.cu", "winner();\n");
  put(root, "artifacts/blogs/blog/code/PROVENANCE.yaml", "files: []\n");
  put(root, "artifacts/blogs/blog/MANIFEST.yaml", stringify({ files: [
    { local_path: "code/01-baseline.cu", heading_path: "## Baseline" },
    { local_path: "code/02-winner.cu", heading_path: "## Winning kernel" },
  ] }));
  return { root, page, bundle: path.join(root, bundle_path) };
}
function manifest(root, entry) {
  put(root, "data/contest-sources.yaml", stringify({ contest: { problem: { "rank-1-author": entry } } }));
}
function submission(page) { return C.load_md(page)[1].submissions[0]; }
const inline = (extra = {}) => ({ kind: "inline-from-blog", blog_slug: "blog", origin_url: "https://example.com/blog", ...extra });
function fake_gh(root) {
  const script = put(root, "bin/gh", `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.env.GH_ARGS_LOG) fs.appendFileSync(process.env.GH_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.env.GH_FAIL) { process.stderr.write(process.env.GH_FAIL); process.exit(7); }\nprocess.stdout.write(process.env.GH_RESPONSE || JSON.stringify({type:'file',content:Buffer.from('kernel();\\n').toString('base64')}));\n`);
  fs.chmodSync(script, 0o755);
  return { PATH: path.dirname(script), GH_ARGS_LOG: path.join(root, "gh-args.jsonl") };
}

test("canonical file defaults to the last progression file and validates explicit names", () => {
  const files = [{ local_path: "baseline.cu" }, { local_path: "winner.cu" }];
  assert.equal(C._resolve_canonical_file({}, files), "winner.cu");
  assert.equal(C._resolve_canonical_file({ canonical_file: "baseline.cu" }, files), "baseline.cu");
  assert.equal(C._resolve_canonical_file({ canonical_file: "absent.cu" }, files), null);
  assert.equal(C._resolve_canonical_file({}, []), null);
  assert.equal(C.rank_author_slug(3, "A / B!"), "rank-3-a-b");
  assert.equal(C.rank_author_slug(null, "中文"), "rank-None-anon");
});

test("inline collection preserves bytes and headings, uses the real page id, and replaces stale bundle atomically", (t) => {
  const { root, page, bundle } = fixture(t);
  manifest(root, inline());
  const body = C.load_md(page)[0][4];
  const result = run("collect-contest-code.mjs", [], root, { env: { PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Collected code for 1 submissions/);
  const sub = submission(page);
  assert.equal(sub.code_path, `${bundle_path}/02-winner.cu`);
  assert.equal(sub.submission_truth, "reconstructed-from-blog");
  assert.equal(sub.code_unavailable_reason, undefined);
  assert.equal(C.load_md(page)[0][4], body);
  assert.deepEqual(fs.readFileSync(path.join(bundle, "02-winner.cu")), fs.readFileSync(path.join(root, "artifacts/blogs/blog/code/02-winner.cu")));
  assert.equal(fs.existsSync(path.join(bundle, "old.cu")), false);
  assert.equal(fs.existsSync(path.join(bundle, "nested")), false);
  const prov = parse(fs.readFileSync(path.join(bundle, "PROVENANCE.yaml"), "utf8"));
  assert.equal(prov.source_contest_id, "contest-curator-id");
  assert.equal(prov.generated_by, "scripts/collect_contest_code.py");
  assert.equal(prov.asset_mode, "extracted");
  assert.equal(prov.files[1].heading_path, "## Winning kernel");
  assert.equal(prov.files[1].sha256, C.sha256_of(path.join(bundle, "02-winner.cu")));
  assert.deepEqual(fs.readdirSync(path.dirname(bundle)), ["rank-1-author"]);
  manifest(root, inline({ canonical_file: "01-baseline.cu", files: ["01-baseline.cu"] }));
  assert.equal(run("collect-contest-code.mjs", [], root).status, 0);
  assert.equal(submission(page).code_path, `${bundle_path}/01-baseline.cu`);
  assert.equal(fs.existsSync(path.join(bundle, "02-winner.cu")), false);
});

test("inline failures keep installed bundle and the original frontmatter, even after truth was tentatively changed", (t) => {
  const { root, page, bundle } = fixture(t);
  const original_page = fs.readFileSync(page);
  const old_bundle = snapshot(bundle);
  for (const entry of [inline({ canonical_file: "absent.cu" }), inline({ blog_slug: "absent" }), inline({ files: ["absent.cu"] }), { kind: "unknown" }]) {
    manifest(root, entry);
    const result = run("collect-contest-code.mjs", [], root);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /1 soft failure\(s\)/);
    assert.deepEqual(fs.readFileSync(page), original_page);
    assert.deepEqual(snapshot(bundle), old_bundle);
    assert.deepEqual(fs.readdirSync(path.dirname(bundle)), ["rank-1-author"]);
  }
});

test("missing manifest and unavailable kinds recursively remove stale bundles and clear code paths", (t) => {
  for (const entry of [null, { kind: "discord-only", reason: "Discord is not public" }, { kind: "unavailable-public" }]) {
    const { root, page, bundle } = fixture(t);
    if (entry) manifest(root, entry);
    const result = run("collect-contest-code.mjs", [], root, { env: { PATH: "" } });
    assert.equal(result.status, 0, result.stderr);
    const sub = submission(page);
    assert.equal(sub.submission_truth, "unavailable");
    assert.equal(sub.code_path, undefined);
    assert.ok(sub.code_unavailable_reason);
    assert.equal(fs.existsSync(bundle), false);
    if (!entry) assert.equal(fs.existsSync(path.dirname(bundle)), false);
  }
});

test("github-file refuses moving or missing refs before any fetch and keeps prior state", (t) => {
  const { root, page, bundle } = fixture(t);
  const env = fake_gh(root);
  const old = snapshot(bundle), old_page = fs.readFileSync(page);
  for (const sha of [undefined, "HEAD", " main ", "MASTER", ""]) {
    manifest(root, { kind: "github-file", upstream_repo: "owner/repo", upstream_sha: sha, files: [{ upstream_path: "kernel.cu" }] });
    const result = run("collect-contest-code.mjs", [], root, { env });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /needs a pinned upstream_sha/);
    assert.deepEqual(snapshot(bundle), old);
    assert.deepEqual(fs.readFileSync(page), old_page);
  }
  assert.equal(fs.existsSync(env.GH_ARGS_LOG), false);
});

test("pinned github-file uses gh contents API, preserves bytes, hashes, and official/posthoc classification", (t) => {
  const { root, page, bundle } = fixture(t);
  const env = fake_gh(root);
  const binary = Buffer.from([0, 1, 255, 13, 10]);
  env.GH_RESPONSE = JSON.stringify({ type: "file", content: binary.toString("base64") + "\n" });
  const entry = { kind: "github-file", upstream_repo: "owner/repo", upstream_sha: "abc1234", origin_url: "https://example.com/source", license: "MIT", official: true, files: [{ upstream_path: "src/kernel.cu", local_name: "captured.cu" }] };
  manifest(root, entry);
  const result = run("collect-contest-code.mjs", [], root, { env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(bundle, "captured.cu")), binary);
  assert.equal(submission(page).submission_truth, "official-submission");
  const args = fs.readFileSync(env.GH_ARGS_LOG, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(args, [["api", "/repos/owner/repo/contents/src/kernel.cu?ref=abc1234"]]);
  const prov = parse(fs.readFileSync(path.join(bundle, "PROVENANCE.yaml"), "utf8"));
  assert.equal(prov.files[0].sha256, C.sha256_of(path.join(bundle, "captured.cu")));
  assert.equal(prov.files[0].mode, "verbatim");
  assert.equal(prov.upstream_sha, "abc1234");
  assert.equal(prov.license, "MIT");
  manifest(root, { ...entry, official: false });
  assert.equal(run("collect-contest-code.mjs", [], root, { env }).status, 0);
  assert.equal(submission(page).submission_truth, "author-published-posthoc");
});

test("gh, non-file, malformed JSON/base64, and bad canonical failures preserve installed truth", (t) => {
  const { root, page, bundle } = fixture(t);
  const env = fake_gh(root);
  const entry = { kind: "github-file", upstream_repo: "owner/repo", upstream_sha: "abc1234", files: [{ upstream_path: "src/kernel.cu" }] };
  const old = snapshot(bundle), old_page = fs.readFileSync(page);
  for (const [extra, changes, pattern] of [
    [{ GH_FAIL: "upstream unavailable " + "x".repeat(150) }, {}, /gh failed: upstream unavailable/],
    [{ GH_RESPONSE: '{"type":"dir"}' }, {}, /non-file response/],
    [{ GH_RESPONSE: "{" }, {}, /SyntaxError/],
    [{ GH_RESPONSE: '{"type":"file","content":"a"}' }, {}, /base64 padding/],
    [{}, { canonical_file: "absent.cu" }, /does not match any local_path/],
  ]) {
    manifest(root, { ...entry, ...changes });
    const result = run("collect-contest-code.mjs", [], root, { env: { ...env, ...extra } });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, pattern);
    assert.deepEqual(snapshot(bundle), old);
    assert.deepEqual(fs.readFileSync(page), old_page);
    assert.deepEqual(fs.readdirSync(path.dirname(bundle)), ["rank-1-author"]);
  }
});

test("an atomic swap failure restores the previous bundle, propagates, and leaves page metadata intact", async (t) => {
  const { root, page, bundle } = fixture(t);
  const c = await import_in_root("collect-contest-code.mjs", root);
  const old = snapshot(bundle), old_page = fs.readFileSync(page);
  const source_manifest = { contest: { problem: { "rank-1-author": inline() } } };
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith(".new") && to === bundle) throw Object.assign(new Error("injected destination failure"), { code: "EACCES" });
    return rename(from, to);
  };
  try { assert.throws(() => c.collect_one(page, 0, original_sub, source_manifest, "contest-curator-id"), /atomic bundle swap failed/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(snapshot(bundle), old);
  assert.deepEqual(fs.readFileSync(page), old_page);
  assert.deepEqual(fs.readdirSync(path.dirname(bundle)), ["rank-1-author"]);
  manifest(root, inline());
  const guard = put(root, "swap-failure.mjs", `import fs from 'node:fs';\nconst rename = fs.renameSync;\nfs.renameSync = (from,to) => { if (String(from).endsWith('.new')) throw new Error('injected swap failure'); return rename(from,to); };\n`);
  const result = run("collect-contest-code.mjs", [], root, { env: { NODE_OPTIONS: `--import=${guard}` } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /swap failed: atomic bundle swap failed/);
  assert.deepEqual(snapshot(bundle), old);
  assert.deepEqual(fs.readFileSync(page), old_page);
});

test("malformed blog manifest falls back to explicit missing-heading provenance", (t) => {
  const { root, bundle } = fixture(t);
  put(root, "artifacts/blogs/blog/MANIFEST.yaml", "files: [");
  manifest(root, inline());
  const result = run("collect-contest-code.mjs", [], root);
  assert.equal(result.status, 0, result.stderr);
  const prov = parse(fs.readFileSync(path.join(bundle, "PROVENANCE.yaml"), "utf8"));
  assert.match(prov.files[0].heading_path, /heading not recorded in blog\/MANIFEST.yaml/);
});

test("dry-run performs no writes or network requests, preserving nonmapping submissions and markdown bodies", (t) => {
  const { root } = fixture(t);
  manifest(root, { kind: "github-file", upstream_repo: "owner/repo", upstream_sha: "abc1234", files: [{ upstream_path: "src/kernel.cu" }] });
  put(root, "sources/contests/contest/notes.md", "# No frontmatter\n");
  put(root, "sources/contests/contest/empty.md", "---\nsubmissions: []\n---\nbody\n");
  const before = snapshot(root);
  const result = run("collect-contest-code.mjs", ["--dry-run"], root, { env: { PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(root), before);
  assert.match(result.stdout, /Collected code for 0 submissions; marked 0/);
  assert.equal(run("collect-contest-code.mjs", ["--unknown"], root).status, 2);
  assert.equal(run("collect-contest-code.mjs", ["--help"], root).status, 0);
});

test("load/save preserves body and Unicode while processing only mapping submissions", async (t) => {
  const root = temp_root(t);
  const page = put(root, page_path, "---\nsubmissions:\n  - literal\n  - rank: 2\n    participant: 作者\n---\n\nUnicode 正文\n");
  const c = await import_in_root("collect-contest-code.mjs", root);
  assert.deepEqual(c.load_manifest(), {});
  const result = run("collect-contest-code.mjs", [], root, { env: { PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  const loaded = c.load_md(page);
  assert.equal(loaded[1].submissions[0], "literal");
  assert.equal(loaded[1].submissions[1].participant, "作者");
  assert.equal(loaded[0][4], "Unicode 正文\n");
  const plain = put(root, "plain.md", "# No frontmatter\n");
  assert.equal(c.load_md(plain), null);
});
