#!/usr/bin/env node
/** Fetch pinned, size-capped PR bundles with atomic replacement and provenance. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseMaintenance as parse } from "./lib/yaml.mjs";
import { dumpSorted, fnmatch, isFile, isMain, REPO_ROOT, walkFiles } from "./compute-core-prs.mjs";
export { REPO_ROOT };
export const ARTIFACTS = path.join(REPO_ROOT, "artifacts", "prs");
export const CORE_PATH = path.join(REPO_ROOT, "data", "core-prs.yaml");
export const BUDGET_PATH = path.join(REPO_ROOT, "data", "phase3-size-budget.yaml");
export const SOURCES_PRS = path.join(REPO_ROOT, "sources", "prs");
export const FILE_SIZE_CAP = 1024 ** 2;
export const BUNDLE_SIZE_CAP = 5 * 1024 ** 2;
export const KERNEL_EXTS_C = new Set([
  ".cu",
  ".cuh",
  ".cpp",
  ".cxx",
  ".cc",
  ".h",
  ".hpp",
  ".hxx",
  ".inl",
]);
export const KERNEL_EXTS_PTX = new Set([".ptx"]);
export const KERNEL_EXTS_PY_STRICT = new Set([".py", ".pyx"]);
export const KERNEL_PY_KEYWORDS = [
  "kernel",
  "triton",
  "cute",
  "ops",
  "csrc",
  "attention",
  "backends",
];
export const SKIP_GLOBS = [
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
  "**/examples/**/test_*",
  "**/examples/**/demo_*",
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
  "**/Makefile",
  "**/*.mk",
  "**/CMakeLists.txt",
  "**/.gitignore",
];
export function runGh(args, capture = true, { exec = execFileSync } = {}) {
  try {
    const out = exec("gh", args, {
      stdio: ["ignore", capture ? "pipe" : "inherit", "pipe"],
      maxBuffer: 1024 ** 3,
    });
    return capture ? Buffer.from(out) : Buffer.alloc(0);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("gh CLI not found; install https://cli.github.com/", {
        cause: error,
      });
    }
    throw new Error(
      `gh ${args.join(" ")} failed: ${Buffer.from(error.stderr || error.message || "")
        .toString()
        .trim()}`,
      {
        cause: error,
      },
    );
  }
}
export function loadCorePrs(root = REPO_ROOT) {
  const file = path.join(root, "data", "core-prs.yaml");
  if (!isFile(file)) {
    throw new Error("missing data/core-prs.yaml; run scripts/compute-core-prs.mjs first");
  }
  const data = parse(readFileSync(file, "utf8"));
  return (data.prs || []).filter((e) => e && Object.hasOwn(e, "id")).map((e) => e.id);
}
function* prPages(root) {
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
    const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) {
      continue;
    }
    let fm;
    try {
      fm = parse(m[1]) || {};
    } catch {
      continue;
    }
    yield [md, fm, text];
  }
}
export function readPrPage(pid, root = REPO_ROOT) {
  for (const page of prPages(root)) {
    if (page[1].id === pid) {
      return page;
    }
  }
  return [null, null, null];
}
export function pathSkipped(posix) {
  return SKIP_GLOBS.some((g) => fnmatch(posix, g));
}
export function fileSuffix(posix) {
  return posix.split("/").at(-1).includes(".") ? "." + posix.split(".").at(-1).toLowerCase() : "";
}
function allowed(file, relaxed) {
  const posix = file.replaceAll("\\", "/");
  if (pathSkipped(posix)) {
    return false;
  }
  const suffix = fileSuffix(posix);
  if (KERNEL_EXTS_C.has(suffix) || KERNEL_EXTS_PTX.has(suffix)) {
    return true;
  }
  if (KERNEL_EXTS_PY_STRICT.has(suffix)) {
    return relaxed || KERNEL_PY_KEYWORDS.some((kw) => posix.toLowerCase().includes(kw));
  }
  return suffix === ".json" && posix.includes("cutlass_configs");
}
export function pathAllowed(file) {
  return allowed(file, false);
}
export function pathAllowedRelaxed(file) {
  return allowed(file, true);
}
export function selectCapturedFiles(fileList) {
  const strict = fileList.filter((f) => pathAllowed(f.filename || ""));
  if (strict.length) {
    return [strict, false];
  }
  const relaxed = fileList.filter((f) => pathAllowedRelaxed(f.filename || ""));
  return [relaxed, Boolean(relaxed.length)];
}
export async function fetchContentAtSha(repo, file, sha, options = {}) {
  const gh = options.runGh || runGh;
  const data = JSON.parse(await gh(["api", `/repos/${repo}/contents/${file}?ref=${sha}`]));
  if (data.type !== "file") {
    throw new Error(
      `unexpected response for ${repo}:${file}@${sha.slice(0, 10)}: type=${data.type ?? "None"}`,
    );
  }
  if (data.content) {
    return Buffer.from(data.content, "base64");
  }
  if (data.download_url) {
    try {
      const response = await (options.fetch || fetch)(data.download_url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch {
      /* The git blob fallback also covers a failed raw download. */
    }
  }
  if (data.sha) {
    return Buffer.from(
      await gh([
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `/repos/${repo}/git/blobs/${data.sha}`,
      ]),
    );
  }
  throw new Error(
    `could not fetch ${repo}:${file}@${sha.slice(0, 10)}: contents response had no \`content\`, no \`download_url\`, and no blob \`sha\``,
  );
}
export async function fetchPrFileList(repo, prNum, { runGh: gh = runGh } = {}) {
  const results = [];
  for (let page = 1; page <= 20; page++) {
    const chunk = JSON.parse(
      await gh(["api", `/repos/${repo}/pulls/${prNum}/files?per_page=100&page=${page}`]),
    );
    if (!Array.isArray(chunk) || !chunk.length) {
      break;
    }
    results.push(...chunk);
    if (chunk.length < 100) {
      break;
    }
  }
  return results;
}
export async function fetchPrWholeDiff(repo, prNum, { runGh: gh = runGh } = {}) {
  return Buffer.from(await gh(["pr", "diff", String(prNum), "-R", repo]));
}
export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Async I/O; optional dependencies/root let tests use disposable local bundles. */
export async function emitBundle(
  repo,
  prNum,
  prId,
  mergeSha,
  fileList,
  wholeDiff,
  dryRun = false,
  options = {},
) {
  const root = options.root || REPO_ROOT,
    log = options.log || console.log;
  const gh = options.runGh || runGh,
    fetchContent = options.fetchContentAtSha || fetchContentAtSha;
  const repoShort = repo.split("/").at(-1).toLowerCase();
  const bundleFinal = path.join(root, "artifacts", "prs", repoShort, `PR-${prNum}`);
  const bundleRel = path.relative(root, bundleFinal);
  const [capturedFiles, usedRelaxed] = selectCapturedFiles(fileList);
  if (dryRun) {
    log(
      `  DRY-RUN ${prId}: ${capturedFiles.length}/${fileList.length} files would be captured${usedRelaxed ? " (relaxed-fallback)" : ""}`,
    );
    for (const f of capturedFiles.slice(0, 20)) {
      log(`    + ${f.filename || ""}`);
    }
    if (capturedFiles.length > 20) {
      log(`    + ... (${capturedFiles.length - 20} more)`);
    }
    return [bundleRel, 0, capturedFiles.length, false];
  }
  const bundleWork = path.join(path.dirname(bundleFinal), `.${path.basename(bundleFinal)}.new`);
  mkdirSync(path.dirname(bundleFinal), {
    recursive: true,
  });
  rmSync(bundleWork, {
    recursive: true,
    force: true,
  });
  mkdirSync(bundleWork);
  let filesEntries = [],
    bundleTotal = 0,
    bundleTruncated = false;
  try {
    if (wholeDiff !== null && wholeDiff !== undefined) {
      writeFileSync(path.join(bundleWork, "diff.patch"), wholeDiff);
      bundleTotal += wholeDiff.length;
      filesEntries.push({
        local_path: "diff.patch",
        role: "pr-diff",
        mode: "upstream-patch",
        sha256: sha256Bytes(wholeDiff),
      });
    }
    let baseSha = null;
    for (const f of capturedFiles) {
      const filename = f.filename || "",
        isRemoved = f.status === "removed";
      let fetchSha = mergeSha;
      if (isRemoved) {
        if (baseSha === null) {
          try {
            baseSha =
              JSON.parse(await gh(["api", `/repos/${repo}/pulls/${prNum}`])).base?.sha || "";
          } catch (error) {
            throw new Error(
              `could not resolve base SHA for removed files in ${repo}#${prNum}: ${error.message}. Aborting PR ${prId} capture (partial bundles are not committed).`,
              {
                cause: error,
              },
            );
          }
        }
        if (!baseSha) {
          throw new Error(
            `${repo}#${prNum} has a removed file (${filename}) but no base SHA resolved; cannot capture pre-deletion content. Aborting PR ${prId} capture.`,
          );
        }
        fetchSha = baseSha;
      }
      let content;
      try {
        content = Buffer.from(await fetchContent(repo, filename, fetchSha, options));
      } catch (error) {
        throw new Error(
          `key-file fetch failed for ${repo}:${filename}@${fetchSha.slice(0, 10)}: ${error.message}. Aborting PR ${prId} capture (partial bundles are not committed).`,
          {
            cause: error,
          },
        );
      }
      const localRel = `key-files/${filename}`,
        outPath = path.join(bundleWork, localRel);
      // Upstream names are POSIX relative paths; never allow a remote path to escape staging.
      const inside = path.relative(path.join(bundleWork, "key-files"), outPath);
      if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(filename)) {
        throw new Error(`invalid upstream file path: ${filename}`);
      }
      const truncated = content.length > FILE_SIZE_CAP;
      if (truncated) {
        content = Buffer.from(
          `/* size_cap_truncated: upstream file is ${content.length} bytes (> ${FILE_SIZE_CAP}). Re-fetch upstream at ${repo}:${filename}@${fetchSha} to read the full content. */\n`,
        );
      }
      mkdirSync(path.dirname(outPath), {
        recursive: true,
      });
      writeFileSync(outPath, content);
      bundleTotal += content.length;
      const entry = {
        local_path: localRel,
        role: "upstream-file",
        mode: "verbatim",
        upstream_path: filename,
        sha256: sha256Bytes(content),
      };
      if (isRemoved) {
        entry.upstream_sha = fetchSha;
        entry.captured_at_base_sha_note = `PR #${prNum} deletes this file. Captured verbatim at the PR's base SHA (pre-merge) so users can inspect the pre-deletion state.`;
      }
      if (truncated) {
        entry.size_cap_truncated = true;
      }
      filesEntries.push(entry);
    }
    const diffPath = path.join(bundleWork, "diff.patch");
    if (bundleTotal > BUNDLE_SIZE_CAP && isFile(diffPath)) {
      bundleTotal -= statSync(diffPath).size;
      unlinkSync(diffPath);
      filesEntries = filesEntries.filter((e) => e.local_path !== "diff.patch");
      bundleTruncated = true;
    }
    if (bundleTotal > BUNDLE_SIZE_CAP) {
      const candidates = filesEntries
        .filter((e) => e.local_path.startsWith("key-files/"))
        .map((e) => [e, statSync(path.join(bundleWork, e.local_path)).size])
        .filter(([, size]) => size > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [entry, originalSize] of candidates) {
        if (bundleTotal <= BUNDLE_SIZE_CAP) {
          break;
        }
        const stub = Buffer.from(
          `/* bundle_cap_truncated: upstream file fits the per-file cap but the aggregate bundle size exceeds ${BUNDLE_SIZE_CAP} bytes. Re-fetch upstream at ${repo}:${entry.upstream_path}@${entry.upstream_sha || mergeSha} to read the full content. */\n`,
        );
        writeFileSync(path.join(bundleWork, entry.local_path), stub);
        entry.sha256 = sha256Bytes(stub);
        entry.size_cap_truncated = true;
        bundleTotal += stub.length - originalSize;
        bundleTruncated = true;
      }
    }
    const prov = {
      origin_url: `https://github.com/${repo}/pull/${prNum}`,
      upstream_repo: repo,
      upstream_sha: mergeSha,
      license: "inherits-from-upstream",
      retrieved_at: (options.today || today)(),
      asset_mode: "verbatim",
      size_cap_truncated: bundleTruncated,
      generated_by: "scripts/fetch-pr-diff.mjs",
      source_pr_id: prId,
      files: filesEntries,
    };
    if (usedRelaxed) {
      prov.captured_via_relaxed_allowlist = true;
    }
    writeFileSync(path.join(bundleWork, "PROVENANCE.yaml"), dumpSorted(prov), "utf8");
  } catch (error) {
    rmSync(bundleWork, {
      recursive: true,
      force: true,
    });
    throw error;
  }
  let bundlePrev = null;
  if (existsSync(bundleFinal)) {
    bundlePrev = path.join(path.dirname(bundleFinal), `.${path.basename(bundleFinal)}.prev`);
    rmSync(bundlePrev, {
      recursive: true,
      force: true,
    });
    renameSync(bundleFinal, bundlePrev);
  }
  try {
    renameSync(bundleWork, bundleFinal);
  } catch (error) {
    if (bundlePrev && existsSync(bundlePrev)) {
      try {
        renameSync(bundlePrev, bundleFinal);
      } catch {
        /* best effort */
      }
    }
    throw new Error(
      `atomic bundle swap failed for ${bundleRel}: ${error.message}; prior bundle restored if possible, staging dir retained at ${bundleWork}`,
      {
        cause: error,
      },
    );
  }
  if (bundlePrev && existsSync(bundlePrev)) {
    rmSync(bundlePrev, {
      recursive: true,
      force: true,
    });
  }
  return [bundleRel, bundleTotal, filesEntries.length, bundleTruncated];
}
export function updatePrPage(mdPath, originalText, bundleRel) {
  const m = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*\r?\n)([\s\S]*)/.exec(originalText);
  if (!m) {
    return false;
  }
  let fm;
  try {
    fm = parse(m[2]) || {};
  } catch {
    return false;
  }
  fm.artifact_dir = String(bundleRel);
  for (const banned of ["diff_path", "code_path", "patch_path", "key_file_path"]) {
    delete fm[banned];
  }
  writeFileSync(mdPath, m[1] + dumpSorted(fm).trimEnd() + m[3] + m[4], "utf8");
  return true;
}
export function selectPilotIds(allIds, allPrsById) {
  const buckets = new Map();
  for (const pid of allIds) {
    const fm = allPrsById instanceof Map ? allPrsById.get(pid) : allPrsById[pid];
    if (!fm) {
      continue;
    }
    const repo = (fm.repo || "").split("/").at(-1).toLowerCase();
    if (!buckets.has(repo)) {
      buckets.set(repo, []);
    }
    buckets.get(repo).push(pid);
  }
  const pilot = ["cutlass", "sglang", "vllm", "flashinfer", "pytorch"].flatMap((repo) =>
    (buckets.get(repo) || []).slice(0, 4),
  );
  for (const pid of allIds) {
    if (pilot.length >= 20) {
      break;
    }
    if (!pilot.includes(pid)) {
      pilot.push(pid);
    }
  }
  return pilot.slice(0, 20);
}
function cliArgs(argv) {
  const args = {
    pilot: false,
    all: false,
    ids: null,
    dry_run: false,
    dry_run_live: false,
    max_pr: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i],
      eq = token.indexOf("="),
      flag = eq < 0 ? token : token.slice(0, eq),
      value = eq < 0 ? null : token.slice(eq + 1);
    const key = {
      "--pilot": "pilot",
      "--all": "all",
      "--dry-run": "dry_run",
      "--dry-run-live": "dry_run_live",
      "--help": "help",
      "-h": "help",
    }[flag];
    if (key) {
      if (value !== null) {
        throw new Error(`${flag} does not take a value`);
      }
      args[key] = true;
    } else if (flag === "--ids") {
      const ids = value !== null ? [value] : [];
      if (value === null) {
        while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          ids.push(argv[++i]);
        }
      }
      if (!ids.length) {
        throw new Error("--ids requires at least one PR_ID");
      }
      args.ids = ids;
    } else if (flag === "--max-pr") {
      const n = value ?? argv[++i];
      if (!n || !/^[+-]?\d+$/.test(n) || !Number.isSafeInteger(Number(n))) {
        throw new Error("--max-pr requires an integer");
      }
      args.max_pr = Number(n);
    } else {
      throw new Error(`unrecognized argument: ${token}`);
    }
  }
  return args;
}
export async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log,
    warn = options.warn || console.error;
  try {
    const args = cliArgs(argv),
      root = options.root || REPO_ROOT;
    if (args.help) {
      log(
        "Usage: fetch-pr-diff.mjs [--pilot | --all | --ids PR_ID ...] [--dry-run] [--dry-run-live] [--max-pr N]\nFetch cleaned, pinned PR bundles; --pilot also writes the size budget.",
      );
      return 0;
    }
    const coreIds = loadCorePrs(root),
      allPrsById = {};
    for (const [, fm] of prPages(root)) {
      if (fm.id) {
        allPrsById[fm.id] = fm;
      }
    }
    let targets;
    if (args.ids) {
      targets = args.ids;
    } else if (args.pilot) {
      targets = selectPilotIds(coreIds, allPrsById);
      log(`Pilot set: ${targets.length} PRs`);
    } else if (args.all) {
      targets = [...coreIds];
    } else {
      throw new Error("must pass --pilot, --all, or --ids");
    }
    if (args.max_pr) {
      targets = targets.slice(0, args.max_pr);
    }
    let ok = 0;
    const pilotStats = [],
      emit = options.emitBundle || emitBundle,
      listFiles = options.fetchPrFileList || fetchPrFileList;
    for (const [i, pid] of targets.entries()) {
      const fm = allPrsById[pid];
      if (!fm) {
        log(`  SKIP ${pid}: no source page found`);
        continue;
      }
      const { repo, pr: prNum, merge_sha: mergeSha } = fm;
      if (!(repo && prNum && mergeSha)) {
        log(`  SKIP ${pid}: missing repo/pr/merge_sha in source page`);
        continue;
      }
      log(`[${i + 1}/${targets.length}] ${pid}  (${repo}#${prNum} @ ${mergeSha.slice(0, 10)})`);
      let fileList;
      if (args.dry_run && !args.dry_run_live) {
        const storedPaths = fm.changed_paths || [];
        if (!storedPaths.length) {
          log(
            `    DRY-RUN ${pid}: source page has no changed_paths; use --dry-run-live to preview from the real PR file list`,
          );
          ok++;
          continue;
        }
        await emit(
          repo,
          prNum,
          pid,
          mergeSha,
          storedPaths.map((filename) => ({
            filename,
          })),
          null,
          true,
          options,
        );
        ok++;
        continue;
      }
      try {
        fileList = await listFiles(repo, prNum, options);
      } catch (error) {
        warn(`    WARN: file-list fetch failed: ${error.message}`);
        continue;
      }
      if (args.dry_run_live) {
        await emit(repo, prNum, pid, mergeSha, fileList, null, true, options);
        ok++;
        continue;
      }
      let wholeDiff;
      try {
        wholeDiff = await (options.fetchPrWholeDiff || fetchPrWholeDiff)(repo, prNum, options);
      } catch (error) {
        warn(`    WARN: diff fetch failed: ${error.message}; continuing without diff.patch`);
        wholeDiff = null;
      }
      let result;
      try {
        result = await emit(repo, prNum, pid, mergeSha, fileList, wholeDiff, false, options);
      } catch (error) {
        warn(`    ERROR: bundle emission failed: ${error.message}`);
        continue;
      }
      const [bundleRel, total, nfiles, truncated] = result;
      log(
        `    -> ${bundleRel} (${nfiles} files, ${(total / 1024).toFixed(1)} KiB, truncated=${truncated ? "True" : "False"})`,
      );
      const [mdPath, , originalText] = readPrPage(pid, root);
      if (mdPath) {
        updatePrPage(mdPath, originalText, bundleRel);
      }
      ok++;
      pilotStats.push({
        pr_id: pid,
        repo,
        pr_number: prNum,
        bundle_bytes: total,
        num_files: nfiles,
        truncated,
      });
    }
    log(`\nFetched ${ok}/${targets.length} PRs successfully.`);
    const partialFailure = ok !== targets.length;
    if (args.pilot && pilotStats.length && !partialFailure) {
      const totalBytes = pilotStats.reduce((n, s) => n + s.bundle_bytes, 0),
        avgBundle = totalBytes / pilotStats.length;
      const projLower = Math.trunc(avgBundle * Math.min(80, coreIds.length) * 1.25),
        projUpper = Math.trunc(avgBundle * 460 * 1.25);
      const budget = {
        generated_by: "scripts/fetch-pr-diff.mjs --pilot",
        pilot_size: pilotStats.length,
        pilot_total_bytes: totalBytes,
        avg_bundle_bytes: Math.trunc(avgBundle),
        core_prs_total: coreIds.length,
        lower_bound_projection_mib: Number((projLower / 1024 ** 2).toFixed(2)),
        upper_bound_projection_mib: Number((projUpper / 1024 ** 2).toFixed(2)),
        active_ceiling_mib:
          projLower < 25 * 1024 ** 2
            ? 25
            : projUpper < 60 * 1024 ** 2
              ? 60
              : Math.floor(projUpper / 1024 ** 2) + 10,
        pilot_entries: pilotStats,
      };
      writeFileSync(path.join(root, "data", "phase3-size-budget.yaml"), dumpSorted(budget), "utf8");
      log(
        `\nWrote data/phase3-size-budget.yaml\n  Avg bundle: ${(avgBundle / 1024).toFixed(1)} KiB\n  Lower-bound projection: ${budget.lower_bound_projection_mib} MiB\n  Upper-bound projection: ${budget.upper_bound_projection_mib} MiB\n  Active ceiling: ${budget.active_ceiling_mib} MiB`,
      );
    } else if (args.pilot && partialFailure) {
      warn(
        `\nSkipping data/phase3-size-budget.yaml write: pilot fetch was partial (${ok}/${targets.length}). Re-run after resolving the gh / upstream issue.`,
      );
    }
    if (partialFailure) {
      warn(
        `\nERROR: ${targets.length - ok} of ${targets.length} requested PR(s) did not fetch successfully. See the per-PR WARN / ERROR lines above.`,
      );
      return 1;
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
