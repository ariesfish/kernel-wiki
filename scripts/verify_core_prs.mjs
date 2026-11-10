#!/usr/bin/env node
/** Verify manifest bytes in memory, optionally resolving pinned merge SHAs upstream. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseMaintenance as parse } from "./_yaml.mjs";
import { REPO_ROOT, _is_file, _is_main, _walk_files, compute_manifests, compute_sha256_of_text, dump_sorted } from "./compute_core_prs.mjs";
import { EnvError, run_gh } from "./verify_verbatim.mjs";
export { REPO_ROOT, EnvError, run_gh };
export const CORE_PATH = path.join(REPO_ROOT, "data", "core-prs.yaml");

export async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log, warn = options.warn || console.error;
  try {
    const { values } = parseArgs({ args: argv, options: { strict: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help) { log("Usage: verify_core_prs.mjs [--strict]\nVerify all three manifests against an in-memory derivation; --strict resolves merge SHAs with gh api."); return 0; }
    const root = options.root || REPO_ROOT;
    if (!_is_file(path.join(root, "data", "core-prs.yaml"))) { warn("ERROR: data/core-prs.yaml does not exist; run scripts/compute_core_prs.mjs first"); return 2; }
    const generated_names = ["core-prs.yaml", "cute-dsl-universe.yaml", "triton-universe.yaml"];
    const committed_bytes = Object.fromEntries(generated_names.map(name => {
      const file = path.join(root, "data", name);
      return [name, _is_file(file) ? readFileSync(file) : null];
    }));
    const fresh_bytes = await (options.compute_manifests || compute_manifests)(root);
    const missing = generated_names.filter(name => !Object.hasOwn(fresh_bytes, name));
    if (missing.length) { warn(`ERROR: compute_manifests() did not produce ${JSON.stringify(missing)}`); return 1; }
    const fresh = parse(fresh_bytes["core-prs.yaml"].toString());
    const untracked = generated_names.filter(name => committed_bytes[name] === null);
    if (untracked.length) {
      warn(`FAIL: generated file(s) missing from data/: ${JSON.stringify(untracked)}`);
      warn(`Fresh derivation would produce ${fresh.total_captured || 0} PRs (checksum ${(fresh.checksum_sha256 || "").slice(0, 12)}...). Run scripts/compute_core_prs.mjs and commit the regenerated files, then re-run this verifier.`);
      return 1;
    }
    const drift = generated_names.filter(name => !committed_bytes[name].equals(Buffer.from(fresh_bytes[name])));
    if (drift.length) {
      warn("FAIL: fresh regeneration does not match the committed generated files:");
      for (const name of drift) warn(`  drifted: data/${name}`);
      warn("\n(If you believe the drift is legitimate, re-run scripts/compute_core_prs.mjs and commit the updated files; re-run this verifier to confirm.)");
      return 1;
    }
    const prs_list = fresh.prs || [];
    if (fresh.total_captured !== prs_list.length) { warn(`FAIL: data/core-prs.yaml total_captured=${fresh.total_captured} does not match len(prs)=${prs_list.length}`); return 1; }
    const expected = compute_sha256_of_text(dump_sorted(prs_list));
    if (fresh.checksum_sha256 !== expected) {
      warn(`FAIL: embedded checksum_sha256 does not match re-computed hash\n  embedded   : ${(fresh.checksum_sha256 || "").slice(0, 20)}...\n  re-computed: ${expected.slice(0, 20)}...`);
      return 1;
    }
    log(`OK: all 3 generated manifests (core-prs, cute-dsl-universe, triton-universe) match committed bytes; internal checksum + total_captured are consistent (checksum ${fresh.checksum_sha256.slice(0, 12)}..., ${fresh.total_captured} PRs)`);
    if (values.strict) {
      let issues = 0, env_failures = 0;
      const sources_prs = {};
      for (const md of _walk_files(path.join(root, "sources", "prs"))) {
        if (!/^PR-.*\.md$/.test(path.basename(md))) continue;
        let text;
        try { text = readFileSync(md, "utf8").replace(/\r\n?/g, "\n"); } catch { continue; }
        const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
        if (!m) continue;
        try { const fm = parse(m[1]) || {}; if (fm.id) sources_prs[fm.id] = fm; } catch { /* Unparseable pages are reported as missing. */ }
      }
      log(`Resolving merge_sha for ${prs_list.length} PRs via gh api...`);
      for (const e of prs_list) {
        const pid = e.id, fm = sources_prs[pid];
        if (!fm) { log(`  WARN: ${pid}: page not found in sources/prs/`); issues++; continue; }
        const { merge_sha: sha, repo, pr: pr_num } = fm;
        if (!(sha && repo && pr_num)) { log(`  WARN: ${pid}: missing merge_sha / repo / pr number`); issues++; continue; }
        try {
          const data = JSON.parse(await (options.run_gh || run_gh)(["api", `/repos/${repo}/pulls/${pr_num}`]));
          if (!data.merged) { log(`  FAIL: ${pid}: upstream state is not merged (state=${data.state})`); issues++; }
          else {
            const upstream_merge = String(data.merge_commit_sha || "");
            if (!(upstream_merge && upstream_merge.startsWith(sha))) {
              const upstream_head = String(data.head?.sha || "");
              log(`  FAIL: ${pid}: recorded merge_sha=${sha.slice(0, 12)}... does not prefix-match upstream merge_commit_sha=${upstream_merge.slice(0, 12)}... (head.sha=${upstream_head.slice(0, 12)}... shown for reference; not accepted)`);
              issues++;
            }
          }
        } catch (error) {
          if (error instanceof EnvError) { warn(`  ENV:  ${pid}: gh unreachable: ${error.message}`); env_failures++; }
          else if (error instanceof SyntaxError) throw error;
          else { log(`  WARN: ${pid}: gh fetch failed: ${error.message}`); issues++; }
        }
      }
      if (env_failures) { warn(`\nSTRICT inconclusive: ${env_failures} environment/connectivity failure(s) while resolving merge_sha via gh api. Re-run with network + authenticated gh to complete verification.`); return 2; }
      if (issues) { log(`\n${issues} strict-mode flag(s).`); return 1; }
    }
    return 0;
  } catch (error) { warn(`ERROR: ${error.message}`); return 2; }
}
if (_is_main(import.meta.url)) process.exitCode = await main();
