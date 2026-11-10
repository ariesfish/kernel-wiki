#!/usr/bin/env node
/** Verify manifest bytes in memory, optionally resolving pinned merge SHAs upstream. */
import { parseJson, stringifyJson } from "./lib/json.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseMaintenance as parse } from "./lib/yaml.mjs";
import {
  computeManifests,
  computeSha256OfText,
  isFile,
  isMain,
  REPO_ROOT,
  walkFiles,
} from "./compute-core-prs.mjs";
import { EnvError, runGh } from "./verify-verbatim.mjs";
export { REPO_ROOT, EnvError, runGh };
export const CORE_PATH = path.join(REPO_ROOT, "data", "core-prs.json");
export async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log,
    warn = options.warn || console.error;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        strict: {
          type: "boolean",
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    });
    if (values.help) {
      log(
        "Usage: verify-core-prs.mjs [--strict]\nVerify all three manifests against an in-memory derivation; --strict resolves merge SHAs with gh api.",
      );
      return 0;
    }
    const root = options.root || REPO_ROOT;
    if (!isFile(path.join(root, "data", "core-prs.json"))) {
      warn("ERROR: data/core-prs.json does not exist; run scripts/compute-core-prs.mjs first");
      return 2;
    }
    const generatedNames = ["core-prs.json", "cute-dsl-universe.json", "triton-universe.json"];
    const committedBytes = Object.fromEntries(
      generatedNames.map((name) => {
        const file = path.join(root, "data", name);
        return [name, isFile(file) ? readFileSync(file) : null];
      }),
    );
    const freshBytes = await (options.computeManifests || computeManifests)(root);
    const missing = generatedNames.filter((name) => !Object.hasOwn(freshBytes, name));
    if (missing.length) {
      warn(`ERROR: computeManifests() did not produce ${JSON.stringify(missing)}`);
      return 1;
    }
    const fresh = parseJson(freshBytes["core-prs.json"].toString());
    const untracked = generatedNames.filter((name) => committedBytes[name] === null);
    if (untracked.length) {
      warn(`FAIL: generated file(s) missing from data/: ${JSON.stringify(untracked)}`);
      warn(
        `Fresh derivation would produce ${fresh.total_captured || 0} PRs (checksum ${(fresh.checksum_sha256 || "").slice(0, 12)}...). Run scripts/compute-core-prs.mjs and commit the regenerated files, then re-run this verifier.`,
      );
      return 1;
    }
    const drift = generatedNames.filter(
      (name) => !committedBytes[name].equals(Buffer.from(freshBytes[name])),
    );
    if (drift.length) {
      warn("FAIL: fresh regeneration does not match the committed generated files:");
      for (const name of drift) {
        warn(`  drifted: data/${name}`);
      }
      warn(
        "\n(If you believe the drift is legitimate, re-run scripts/compute-core-prs.mjs and commit the updated files; re-run this verifier to confirm.)",
      );
      return 1;
    }
    const prsList = fresh.prs || [];
    if (fresh.total_captured !== prsList.length) {
      warn(
        `FAIL: data/core-prs.json total_captured=${fresh.total_captured} does not match len(prs)=${prsList.length}`,
      );
      return 1;
    }
    const expected = computeSha256OfText(stringifyJson(prsList));
    if (fresh.checksum_sha256 !== expected) {
      warn(
        `FAIL: embedded checksum_sha256 does not match re-computed hash\n  embedded   : ${(fresh.checksum_sha256 || "").slice(0, 20)}...\n  re-computed: ${expected.slice(0, 20)}...`,
      );
      return 1;
    }
    log(
      `OK: all 3 generated manifests (core-prs, cute-dsl-universe, triton-universe) match committed bytes; internal checksum + total_captured are consistent (checksum ${fresh.checksum_sha256.slice(0, 12)}..., ${fresh.total_captured} PRs)`,
    );
    if (values.strict) {
      let issues = 0,
        envFailures = 0;
      const sourcesPrs = {};
      for (const md of walkFiles(path.join(root, "sources", "prs"))) {
        if (!/^PR-.*\.md$/.test(path.basename(md))) {
          continue;
        }
        let text;
        try {
          text = readFileSync(md, "utf8").replace(/\r\n?/g, "\n");
        } catch {
          continue;
        }
        const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
        if (!m) {
          continue;
        }
        try {
          const fm = parse(m[1]) || {};
          if (fm.id) {
            sourcesPrs[fm.id] = fm;
          }
        } catch {
          /* Unparseable pages are reported as missing. */
        }
      }
      log(`Resolving merge_sha for ${prsList.length} PRs via gh api...`);
      for (const e of prsList) {
        const pid = e.id,
          fm = sourcesPrs[pid];
        if (!fm) {
          log(`  WARN: ${pid}: page not found in sources/prs/`);
          issues++;
          continue;
        }
        const { merge_sha: sha, repo, pr: prNum } = fm;
        if (!(sha && repo && prNum)) {
          log(`  WARN: ${pid}: missing merge_sha / repo / pr number`);
          issues++;
          continue;
        }
        try {
          const data = JSON.parse(
            await (options.runGh || runGh)(["api", `/repos/${repo}/pulls/${prNum}`]),
          );
          if (!data.merged) {
            log(`  FAIL: ${pid}: upstream state is not merged (state=${data.state})`);
            issues++;
          } else {
            const upstreamMerge = String(data.merge_commit_sha || "");
            if (!(upstreamMerge && upstreamMerge.startsWith(sha))) {
              const upstreamHead = String(data.head?.sha || "");
              log(
                `  FAIL: ${pid}: recorded merge_sha=${sha.slice(0, 12)}... does not prefix-match upstream merge_commit_sha=${upstreamMerge.slice(0, 12)}... (head.sha=${upstreamHead.slice(0, 12)}... shown for reference; not accepted)`,
              );
              issues++;
            }
          }
        } catch (error) {
          if (error instanceof EnvError) {
            warn(`  ENV:  ${pid}: gh unreachable: ${error.message}`);
            envFailures++;
          } else if (error instanceof SyntaxError) {
            throw error;
          } else {
            log(`  WARN: ${pid}: gh fetch failed: ${error.message}`);
            issues++;
          }
        }
      }
      if (envFailures) {
        warn(
          `\nSTRICT inconclusive: ${envFailures} environment/connectivity failure(s) while resolving merge_sha via gh api. Re-run with network + authenticated gh to complete verification.`,
        );
        return 2;
      }
      if (issues) {
        log(`\n${issues} strict-mode flag(s).`);
        return 1;
      }
    }
    return 0;
  } catch (error) {
    warn(`ERROR: ${error.message}`);
    return 2;
  }
}
if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
