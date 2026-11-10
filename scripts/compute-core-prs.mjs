#!/usr/bin/env node
/** Deterministically derive the core PR set and CuTe DSL / Triton universes. */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseMaintenance as parse, stringifyMaintenance as stringify } from "./lib/yaml.mjs";
export const REPO_ROOT = path.resolve(
  process.env.BLACKWELL_WIKI_ROOT || fileURLToPath(new URL("../", import.meta.url)),
);
export const SOURCES = path.join(REPO_ROOT, "sources");
export const WIKI = path.join(REPO_ROOT, "wiki");
export const DATA = path.join(REPO_ROOT, "data");
export function isMain(url) {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(url);
  } catch {
    return false;
  }
}
export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
export function* walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return;
    }
    throw error;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// Python fnmatch treats slash like any other character, and ** like *.
// Node's path glob semantics are different, so translate the small shell grammar.
const globCache = new Map();
export function fnmatch(value, glob) {
  let re = globCache.get(glob);
  if (!re) {
    let source = "";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*") {
        source += ".*";
      } else if (c === "?") {
        source += ".";
      } else if (c === "[") {
        let end = i + 1;
        if (glob[end] === "!") {
          end++;
        }
        if (glob[end] === "]") {
          end++;
        }
        while (end < glob.length && glob[end] !== "]") {
          end++;
        }
        if (end === glob.length) {
          source += "\\[";
        } else {
          let group = glob.slice(i + 1, end).replaceAll("\\", "\\\\");
          if (group.startsWith("!")) {
            group = "^" + group.slice(1);
          } else if (group.startsWith("^")) {
            group = "\\" + group;
          }
          // Escape a literal initial ] for JavaScript character classes.
          group = group.replace(/^(\^?)\]/, "$1\\]");
          source += `[${group}]`;
          i = end;
        }
      } else {
        source += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      }
    }
    re = new RegExp(`^(?:${source})$(?![\\s\\S])`, "s");
    globCache.set(glob, re);
  }
  return re.test(value);
}
export function extractFrontmatter(mdPath) {
  let text;
  try {
    text = readFileSync(mdPath, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return [null, ""];
  }
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)/.exec(text);
  if (!m) {
    return [null, text];
  }
  try {
    return [parse(m[1]), m[2]];
  } catch {
    return [null, m[2]];
  }
}
export function loadAllPrs(root = REPO_ROOT) {
  const prs = {};
  for (const md of [...walkFiles(path.join(root, "sources", "prs"))].sort()) {
    if (!/^PR-.*\.md$/.test(path.basename(md))) {
      continue;
    }
    const [fm] = extractFrontmatter(md);
    if (!fm || !Object.hasOwn(fm, "id")) {
      continue;
    }
    prs[fm.id] = {
      ...fm,
      _path: path.relative(root, md),
    };
  }
  return prs;
}
export function graphClosureFromWiki(root = REPO_ROOT) {
  const ids = new Set();
  for (const md of [...walkFiles(path.join(root, "wiki"))].sort()) {
    if (!md.endsWith(".md")) {
      continue;
    }
    const [fm] = extractFrontmatter(md);
    for (const sid of fm?.sources || []) {
      if (typeof sid === "string" && sid.startsWith("pr-")) {
        ids.add(sid);
      }
    }
  }
  return ids;
}
export function contestReferencedPrs(root = REPO_ROOT) {
  const ids = new Set();
  for (const md of [...walkFiles(path.join(root, "sources", "contests"))].sort()) {
    if (!md.endsWith(".md")) {
      continue;
    }
    const [fm] = extractFrontmatter(md);
    if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
      continue;
    }
    for (const pid of fm.referenced_prs || []) {
      if (typeof pid === "string" && pid.startsWith("pr-")) {
        ids.add(pid);
      }
    }
  }
  return ids;
}
export function pathMatchesAny(paths, globs) {
  return paths.some((p) => globs.some((g) => fnmatch(p, g)));
}
export const FETCH_SKIP_GLOBS = [
  "tests/**",
  "**/tests/**",
  "test/**",
  "**/test/**",
  "*_test.cu",
  "*_test.cpp",
  "*_tests.py",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_tests.py",
  "**/conftest.py",
  "benchmark/**",
  "benchmarks/**",
  "bench/**",
  "**/benchmark/**",
  "**/benchmarks/**",
  "**/bench/**",
  "**/bench_*.py",
  "**/*_bench.py",
  "**/*_benchmark.py",
  "docs/**",
  "**/docs/**",
  "**/README*",
  "**/CHANGELOG*",
  "**/release_notes*",
  "**/LICENSE*",
  "**/NOTICE*",
  ".github/**",
  "**/.github/**",
  "ci/**",
  "**/ci/**",
];
export function allPathsWouldBeSkippedByFetch(paths) {
  return Boolean(paths?.length) && paths.every((p) => pathMatchesAny([p], FETCH_SKIP_GLOBS));
}
export const STRONG_CUTE_GLOBS = [
  "cute/**",
  "**/cute/**",
  "cute_dsl/**",
  "**/cute_dsl/**",
  "**/cutlass.cute.**",
  "examples/cute_dsl/**",
  "**/examples/cute_dsl/**",
  "examples/python/CuTeDSL/**",
  "**/examples/python/CuTeDSL/**",
  "tools/cute/**",
  "**/tools/cute/**",
  "**/*cutedsl*.py",
  "**/*cutedsl*.cu",
];
export const KERNEL_OR_EXAMPLE_GLOBS = [
  ...STRONG_CUTE_GLOBS,
  "examples/**/*.cu",
  "**/examples/**/*.cu",
  "examples/**/*.cuh",
  "**/examples/**/*.cuh",
  "examples/**/*.hpp",
  "**/examples/**/*.hpp",
];
const noiseReason =
  "all changed_paths are tests/benchmarks/docs (empty bundle after fetch_pr_diff.SKIP_GLOBS)";
export function applyCuteDslPolicy(policy, pr) {
  const rules = policy["cute-dsl"] || {};
  const langs = new Set(pr.languages || []),
    tags = new Set(pr.tags || []);
  const changedPaths = pr.changed_paths || [];
  const nonSkipPaths = changedPaths.filter((p) => !pathMatchesAny([p], FETCH_SKIP_GLOBS));
  const hasStrongCute = pathMatchesAny(nonSkipPaths, STRONG_CUTE_GLOBS);
  const hasKernelExample = pathMatchesAny(nonSkipPaths, KERNEL_OR_EXAMPLE_GLOBS);
  if (!(langs.has("cute-dsl") || tags.has("cute-dsl") || hasStrongCute)) {
    return [false, "not a cute-dsl PR"];
  }
  const skipGlobs = (rules.skip_criteria || []).flatMap((crit) =>
    crit && typeof crit === "object" ? crit.changed_paths_match_only || [] : [],
  );
  if (
    skipGlobs.length &&
    changedPaths.length &&
    changedPaths.every((p) => pathMatchesAny([p], skipGlobs))
  ) {
    return [false, "documentation-only CuTe DSL PR"];
  }
  if (allPathsWouldBeSkippedByFetch(changedPaths)) {
    return [false, noiseReason];
  }
  if (!hasKernelExample) {
    return [
      false,
      "cute-dsl PR with no kernel/example path match after fetch-skip filtering (control-plane / affinity only; policy requires a kernel/example path)",
    ];
  }
  return [true, null];
}
export function applyTritonPolicy(policy, pr) {
  const langs = new Set(pr.languages || []),
    tags = new Set(pr.tags || []);
  if (!(langs.has("triton") || tags.has("triton"))) {
    return [false, "not a triton PR"];
  }
  const archs = new Set(pr.architectures || []),
    symptoms = new Set(pr.symptoms || []);
  const changedPaths = pr.changed_paths || [];
  const title = String(pr.title || "");
  const desc = `${String(pr.description || "").toLowerCase()} ${title.toLowerCase()}`;
  if (archs.size && [...archs].every((a) => a === "sm90" || a === "sm90a")) {
    return [false, "pure Hopper Triton (no SM100 relevance)"];
  }
  if (/\[\s*(rocm|amd|hip|intel\s*gpu|xpu|mps|cpu)\s*\]/i.test(title)) {
    return [
      false,
      `Triton PR tagged for a non-Blackwell vendor backend in title (${title.split("]")[0]}]); SM100 metadata is incidental Triton backend coverage, not Blackwell kernel authorship`,
    ];
  }
  if (
    changedPaths.length &&
    changedPaths.every((p) => pathMatchesAny([p], ["**/config/**", "**/__init__.py"]))
  ) {
    return [false, "runtime-config-only Triton PR"];
  }
  if (allPathsWouldBeSkippedByFetch(changedPaths)) {
    return [false, noiseReason];
  }
  if (symptoms.has("memory-bound") || symptoms.has("low-sm-utilization")) {
    return [true, null];
  }
  if (
    archs.has("sm100") &&
    pathMatchesAny(changedPaths, [
      "**/triton_kernels/**",
      "**/triton/**",
      "**/triton_*.py",
      "**/*_triton.py",
      "**/*_triton_*.py",
    ])
  ) {
    return [true, null];
  }
  if (
    [
      "fallback",
      "fall back",
      "fall-back",
      "falls back",
      "falling back",
      "sm100 path",
      "cutlass is unavailable",
    ].some((kw) => desc.includes(kw))
  ) {
    return [true, null];
  }
  return [false, "Triton PR outside the three in-policy sub-scopes"];
}
export function dumpSorted(d, sortKeys = false) {
  return stringify(d, {
    indentSeq: false,
    lineWidth: 80,
    sortMapEntries: sortKeys,
  });
}
export function computeSha256OfText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
export function buildUniverse(policy, allPrs, applyFn) {
  return Object.keys(allPrs)
    .sort()
    .map((id) => {
      const [captured, reason] = applyFn(policy, allPrs[id]);
      return captured
        ? {
            id,
            captured: true,
          }
        : {
            id,
            captured: false,
            skipped_reason: reason,
          };
    });
}
export function buildCuteUniverse(policy, allPrs) {
  const candidates = Object.fromEntries(
    Object.entries(allPrs).filter(
      ([, pr]) =>
        (pr.languages || []).includes("cute-dsl") ||
        (pr.tags || []).includes("cute-dsl") ||
        pathMatchesAny(pr.changed_paths || [], STRONG_CUTE_GLOBS),
    ),
  );
  return buildUniverse(policy, candidates, applyCuteDslPolicy);
}
export function filterCandidates(universe, predicate) {
  return universe.filter(predicate);
}
export function universeText(entries, laneName, capturedCount, skippedCount) {
  return (
    "## Auto-generated by scripts/compute-core-prs.mjs — DO NOT EDIT BY HAND.\n## Re-run the script after any corpus change.\n\n" +
    dumpSorted({
      lane: laneName,
      generated_by: "scripts/compute-core-prs.mjs",
      total: entries.length,
      captured: capturedCount,
      skipped: skippedCount,
      prs: entries,
    })
  );
}
export function writeUniverseFile(file, entries, laneName, capturedCount, skippedCount) {
  writeFileSync(file, universeText(entries, laneName, capturedCount, skippedCount), "utf8");
}
/** Read-only library entry point; returns filename -> Buffer. Optional root supports fixtures. */
export function computeManifests(root = REPO_ROOT) {
  const data = path.join(root, "data");
  const policyPath = path.join(data, "inclusion-policy.yaml");
  if (!isFile(policyPath)) {
    throw new Error("data/inclusion-policy.yaml not found");
  }
  const policy = parse(readFileSync(policyPath, "utf8")) || {};
  const allowlistPath = path.join(data, "core-prs-allowlist.yaml");
  const allowlist = isFile(allowlistPath) ? parse(readFileSync(allowlistPath, "utf8")) || {} : {};
  const allPrs = loadAllPrs(root);
  const cuteEntries = buildCuteUniverse(policy, allPrs);
  const tritonCandidates = Object.fromEntries(
    Object.entries(allPrs).filter(
      ([, pr]) => (pr.languages || []).includes("triton") || (pr.tags || []).includes("triton"),
    ),
  );
  const tritonEntries = buildUniverse(policy, tritonCandidates, applyTritonPolicy);
  const sourceOf = new Map();
  const add = (pid, source) => {
    if (Object.hasOwn(allPrs, pid) && !sourceOf.has(pid)) {
      sourceOf.set(pid, source);
    }
  };
  for (const pid of [...graphClosureFromWiki(root)].sort()) {
    add(pid, "wiki-graph-closure");
  }
  for (const pid of [...contestReferencedPrs(root)].sort()) {
    add(pid, "contest-reference");
  }
  for (const e of cuteEntries) {
    if (e.captured) {
      add(e.id, "cute-dsl-tutorial");
    }
  }
  for (const e of tritonEntries) {
    if (e.captured) {
      add(e.id, "triton-in-policy");
    }
  }
  for (const e of Array.isArray(allowlist.additions) ? allowlist.additions : []) {
    if (e && typeof e === "object" && Object.hasOwn(e, "pr")) {
      add(e.pr, "allowlist");
    }
  }
  for (const e of Array.isArray(allowlist.exclusions) ? allowlist.exclusions : []) {
    if (e && typeof e === "object" && Object.hasOwn(e, "pr")) {
      sourceOf.delete(e.pr);
    }
  }
  const prs = [...sourceOf.keys()].sort().map((id) => ({
    id,
    source_of_inclusion: sourceOf.get(id),
  }));
  const corePayload = {
    generated_by: "scripts/compute-core-prs.mjs",
    sources: [
      "wiki-graph-closure",
      "contest-reference",
      "cute-dsl-tutorial",
      "triton-in-policy",
      "allowlist",
    ],
    total_captured: prs.length,
    checksum_sha256: computeSha256OfText(dumpSorted(prs)),
    prs,
  };
  const coreText =
    "## Auto-generated by scripts/compute-core-prs.mjs — DO NOT EDIT BY HAND.\n## Use data/core-prs-allowlist.yaml to add or exclude PRs; then re-run the script.\n\n" +
    dumpSorted(corePayload);
  const laneText = (entries, lane) =>
    universeText(
      entries,
      lane,
      entries.filter((e) => e.captured).length,
      entries.filter((e) => !e.captured).length,
    );
  return {
    "core-prs.yaml": Buffer.from(coreText),
    "cute-dsl-universe.yaml": Buffer.from(laneText(cuteEntries, "cute-dsl")),
    "triton-universe.yaml": Buffer.from(laneText(tritonEntries, "triton")),
  };
}
export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "output-dir": {
          type: "string",
          default: DATA,
        },
        stdout: {
          type: "boolean",
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    }));
    if (values.help) {
      console.log(
        "Usage: compute-core-prs.mjs [--output-dir DIR] [--stdout]\nCompute the deterministic core PR set and CuTe DSL / Triton universes.",
      );
      return 0;
    }
    const manifests = computeManifests();
    if (values.stdout) {
      for (const [name, payload] of Object.entries(manifests)) {
        process.stdout.write(`### FILE: ${name}\n`);
        process.stdout.write(payload);
        process.stdout.write("\n");
      }
      return 0;
    }
    const outDir = path.resolve(values["output-dir"]);
    mkdirSync(outDir, {
      recursive: true,
    });
    for (const [name, payload] of Object.entries(manifests)) {
      writeFileSync(path.join(outDir, name), payload);
    }
    const core = parse(manifests["core-prs.yaml"].toString()),
      cute = parse(manifests["cute-dsl-universe.yaml"].toString()),
      triton = parse(manifests["triton-universe.yaml"].toString());
    console.log(
      `core-prs.yaml: ${core.total_captured} PRs captured (checksum ${core.checksum_sha256.slice(0, 12)}...)`,
    );
    console.log(`cute-dsl-universe.yaml: ${cute.total} candidates (${cute.captured} captured)`);
    console.log(`triton-universe.yaml: ${triton.total} candidates (${triton.captured} captured)`);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }
}
if (isMain(import.meta.url)) {
  process.exitCode = main();
}
