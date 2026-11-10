#!/usr/bin/env node
/** Collect author-published contest code, preserving the installed bundle on failure. */
import { readJson } from "./lib/json.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parseMaintenance as parse, stringifyMaintenance as stringify } from "./lib/yaml.mjs";
const configuredRoot = process.env.BLACKWELL_WIKI_ROOT;
export const REPO = configuredRoot
  ? path.resolve(
      configuredRoot === "~" ? os.homedir() : configuredRoot.replace(/^~\//, `${os.homedir()}/`),
    )
  : path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const CONTESTS_SRC = path.join(REPO, "sources", "contests");
export const CONTESTS_ART = path.join(REPO, "artifacts", "contests");
export const MANIFEST = path.join(REPO, "data", "contest-sources.json");
const GENERATED_BY = "scripts/collect_contest_code.py";
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p) => fs.existsSync(p);
const mapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pyStr = (v) => (v == null ? "None" : String(v));
const removeTree = (p) =>
  fs.rmSync(p, {
    recursive: true,
    force: true,
  });
const ignoreRemove = (p) => {
  try {
    removeTree(p);
  } catch {
    /* Best-effort scratch cleanup. */
  }
};
class BundleSwapError extends Error {}
export function sha256Of(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
export function runGh(args) {
  const result = spawnSync("gh", args, {
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`gh exited with status ${result.status}`);
    error.name = "CalledProcessError";
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}
export function rankAuthorSlug(rank, participant) {
  const slug =
    participant
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "anon";
  return `rank-${pyStr(rank)}-${slug}`;
}
export function loadMd(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
  const match = /^(---\s*\n)(.*?)(\n---\s*\n)(.*)/s.exec(text);
  if (!match) {
    return null;
  }
  return [match, parse(match[2]) || {}, text];
}
export function saveMd(filePath, originalMatch, fm) {
  const newFm = stringify(fm, {
    lineWidth: 0,
  }).trimEnd();
  fs.writeFileSync(
    filePath,
    originalMatch[1] + newFm + originalMatch[3] + originalMatch[4],
    "utf8",
  );
}
export function loadManifest() {
  return isFile(MANIFEST) ? readJson(MANIFEST) || {} : {};
}
export function resolveCanonicalFile(entry, filesList) {
  const declared = mapping(entry) ? entry.canonical_file : null;
  if (declared) {
    return filesList.some((file) => file.local_path === declared) ? declared : null;
  }
  return filesList.length ? (filesList.at(-1).local_path ?? null) : null;
}
function decodeContent(content) {
  if (typeof content !== "string") {
    throw new TypeError("GitHub file content must be a base64 string");
  }
  const cleaned = content.replace(/[^A-Za-z0-9+/=]/g, "");
  const data = cleaned.split("=", 1)[0];
  const remainder = data.length % 4;
  const padding = cleaned.slice(data.length).match(/^=*/)[0].length;
  if (remainder === 1 || (remainder && padding < 4 - remainder)) {
    throw new TypeError("Incorrect base64 padding");
  }
  return Buffer.from(cleaned, "base64");
}
/** Commit completed staging bytes, restoring the previous bundle on failure. */
function commitBundle(bundleWork, bundleFinal, parent) {
  let previous = null;
  if (exists(bundleFinal)) {
    previous = path.join(parent, `.${path.basename(bundleFinal)}.prev`);
    if (exists(previous)) {
      ignoreRemove(previous);
    }
    try {
      fs.renameSync(bundleFinal, previous);
    } catch {
      previous = null;
    }
  }
  try {
    fs.renameSync(bundleWork, bundleFinal);
  } catch (error) {
    if (previous !== null && exists(previous)) {
      try {
        fs.renameSync(previous, bundleFinal);
      } catch {
        /* Restore when possible. */
      }
    }
    if (exists(bundleWork)) {
      ignoreRemove(bundleWork);
    }
    throw new BundleSwapError(
      `atomic bundle swap failed for ${bundleFinal}: ${error.message}; prior bundle restored if possible`,
      {
        cause: error,
      },
    );
  }
  if (previous !== null && exists(previous)) {
    ignoreRemove(previous);
  }
}
export function collectOne(contestPage, subIdx, sub, manifest, contestPageId = null) {
  const contestSlug = path.basename(path.dirname(contestPage));
  const problemSlug = path.basename(contestPage, path.extname(contestPage));
  const raSlug = rankAuthorSlug(sub.rank, sub.participant || "anon");
  const bundleFinal = path.join(CONTESTS_ART, contestSlug, problemSlug, "submissions", raSlug);
  const entry = manifest[contestSlug]?.[problemSlug]?.[raSlug];
  const newSub = {
    ...sub,
  };
  if (!entry || (mapping(entry) && !Object.keys(entry).length)) {
    if (isDir(bundleFinal)) {
      removeTree(bundleFinal);
      const parent = path.dirname(bundleFinal);
      try {
        if (isDir(parent) && !fs.readdirSync(parent).length) {
          fs.rmdirSync(parent);
        }
      } catch {
        /* Non-fatal. */
      }
    }
    newSub.submission_truth = "unavailable";
    newSub.code_unavailable_reason =
      "No public author-republished source declared in data/contest-sources.json; add an entry if a public URL becomes available.";
    delete newSub.code_path;
    return [newSub, false, null];
  }
  const kind = entry.kind;
  const originUrl = entry.origin_url ?? "";
  const files = [];
  if (["discord-only", "unavailable-public"].includes(kind)) {
    if (isDir(bundleFinal)) {
      removeTree(bundleFinal);
    }
    newSub.submission_truth = "unavailable";
    newSub.code_unavailable_reason = entry.reason ?? `kind=${kind}; no public code`;
    delete newSub.code_path;
    return [newSub, false, null];
  }
  const parent = path.dirname(bundleFinal);
  fs.mkdirSync(parent, {
    recursive: true,
  });
  const bundleWork = path.join(parent, `.${path.basename(bundleFinal)}.new`);
  if (exists(bundleWork)) {
    removeTree(bundleWork);
  }
  fs.mkdirSync(bundleWork, {
    recursive: true,
  });
  let swapOnExit = false;
  try {
    if (kind === "github-file") {
      const repo = entry.upstream_repo;
      if (repo === undefined) {
        throw new TypeError("missing upstream_repo");
      }
      const sha = entry.upstream_sha;
      if (!sha || ["HEAD", "MAIN", "MASTER", ""].includes(String(sha).trim().toUpperCase())) {
        return [
          newSub,
          false,
          `manifest kind=github-file for ${repo} needs a pinned upstream_sha (40-char commit SHA or short prefix); refusing to fetch at '${sha || "missing"}' which would produce an unpinned, unverifiable bundle`,
        ];
      }
      for (const spec of entry.files || []) {
        const src = spec.upstream_path;
        if (src === undefined) {
          throw new TypeError("missing upstream_path");
        }
        const outName = spec.local_name || src.split("/").at(-1);
        const out = path.join(bundleWork, outName);
        const doc = JSON.parse(
          runGh(["api", `/repos/${repo}/contents/${src}?ref=${sha}`]).toString("utf8"),
        );
        if (doc.type !== "file") {
          return [newSub, false, `non-file response for ${repo}:${src}`];
        }
        fs.writeFileSync(out, decodeContent(doc.content));
        files.push({
          local_path: outName,
          role: "upstream-file",
          mode: "verbatim",
          upstream_path: src,
          sha256: sha256Of(out),
        });
      }
      fs.writeFileSync(
        path.join(bundleWork, "PROVENANCE.yaml"),
        stringify({
          origin_url: originUrl,
          upstream_repo: repo,
          upstream_sha: sha,
          license: entry.license ?? "inherits-from-upstream",
          retrieved_at: "2026-04-17",
          asset_mode: "verbatim",
          size_cap_truncated: false,
          generated_by: GENERATED_BY,
          source_contest_id: contestPageId || `contest-${contestSlug}-${problemSlug}`,
          files,
        }),
      );
      newSub.submission_truth = entry.official ? "official-submission" : "author-published-posthoc";
      const canonical = resolveCanonicalFile(entry, files);
      if (canonical === null) {
        return [
          newSub,
          false,
          `manifest canonical_file='${pyStr(entry.canonical_file)}' does not match any local_path in the fetched bundle; fix the manifest`,
        ];
      }
      newSub.code_path = `artifacts/contests/${contestSlug}/${problemSlug}/submissions/${raSlug}/${canonical}`;
      delete newSub.code_unavailable_reason;
      swapOnExit = true;
      return [newSub, true, null];
    }
    if (kind === "inline-from-blog") {
      const blogSlug = entry.blog_slug;
      if (blogSlug === undefined) {
        throw new TypeError("missing blog_slug");
      }
      const blogBundle = path.join(REPO, "artifacts", "blogs", blogSlug);
      const blogCodeDir = path.join(blogBundle, "code");
      if (!isDir(blogCodeDir)) {
        return [newSub, false, `blog code bundle ${blogSlug} not extracted yet`];
      }
      const blogManifestPath = path.join(blogBundle, "MANIFEST.yaml");
      const blogFiles = new Map();
      if (isFile(blogManifestPath)) {
        try {
          const bm = parse(fs.readFileSync(blogManifestPath, "utf8")) || {};
          for (const file of bm.files || []) {
            if (file.local_path?.startsWith("code/")) {
              blogFiles.set(file.local_path.slice(5), file);
            }
          }
        } catch (e) {
          if (e.name !== "YAMLParseError") {
            throw e;
          }
        }
      }
      const want = new Set(entry.files || []);
      for (const name of fs.readdirSync(blogCodeDir).sort()) {
        const source = path.join(blogCodeDir, name);
        if (name === "PROVENANCE.yaml" || !isFile(source) || (want.size && !want.has(name))) {
          continue;
        }
        const dst = path.join(bundleWork, name);
        fs.copyFileSync(source, dst);
        fs.chmodSync(dst, fs.statSync(source).mode & 0o7777);
        const heading =
          blogFiles.get(name)?.heading_path ||
          `(heading not recorded in ${blogSlug}/MANIFEST.yaml)`;
        files.push({
          local_path: name,
          role: "extracted-block",
          mode: "extracted",
          upstream_path: `sources/blogs/${blogSlug}.md`,
          heading_path: heading,
          sha256: sha256Of(dst),
        });
      }
      if (!files.length) {
        return [newSub, false, "no matching files in blog bundle"];
      }
      fs.writeFileSync(
        path.join(bundleWork, "PROVENANCE.yaml"),
        stringify({
          origin_url: originUrl,
          upstream_repo: `blog/${blogSlug}`,
          upstream_sha: "none",
          license: "inherits-from-source-blog",
          retrieved_at: "2026-04-17",
          asset_mode: "extracted",
          size_cap_truncated: false,
          generated_by: GENERATED_BY,
          source_contest_id: contestPageId || `contest-${contestSlug}-${problemSlug}`,
          files,
        }),
      );
      newSub.submission_truth = "reconstructed-from-blog";
      const canonical = resolveCanonicalFile(entry, files);
      if (canonical === null) {
        return [
          newSub,
          false,
          `manifest canonical_file='${pyStr(entry.canonical_file)}' does not match any local_path in the reconstructed bundle for ${blogSlug}`,
        ];
      }
      newSub.code_path = `artifacts/contests/${contestSlug}/${problemSlug}/submissions/${raSlug}/${canonical}`;
      delete newSub.code_unavailable_reason;
      swapOnExit = true;
      return [newSub, true, null];
    }
    return [newSub, false, `unknown kind '${pyStr(kind)}'`];
  } catch (e) {
    if (e.name === "CalledProcessError") {
      return [newSub, false, `gh failed: ${e.stderr.toString("utf8").trim().slice(0, 120)}`];
    }
    return [newSub, false, `${e.name}: ${e.message}`];
  } finally {
    if (swapOnExit) {
      commitBundle(bundleWork, bundleFinal, parent);
    } else if (exists(bundleWork)) {
      ignoreRemove(bundleWork);
    }
  }
}
function* markdownFiles(root) {
  if (!isDir(root)) {
    return;
  }
  for (const entry of fs.readdirSync(root, {
    withFileTypes: true,
  })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* markdownFiles(full);
    } else if (entry.name.endsWith(".md")) {
      yield full;
    }
  }
}
export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        "dry-run": {
          type: "boolean",
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    }).values;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 2;
  }
  if (args.help) {
    console.log(
      "Usage: collect-contest-code.mjs [-h] [--dry-run]\nCollect contest submission code from data/contest-sources.json.",
    );
    return 0;
  }
  const manifest = loadManifest();
  let wrote = 0,
    unavailable = 0;
  const fails = [];
  for (const file of [...markdownFiles(CONTESTS_SRC)].sort()) {
    const loaded = loadMd(file);
    if (!loaded) {
      continue;
    }
    const [match, fm] = loaded;
    const subs = fm.submissions || [];
    if (!subs.length) {
      continue;
    }
    const newSubs = [];
    let changed = false;
    for (const [i, sub] of subs.entries()) {
      if (!mapping(sub) || args["dry-run"]) {
        newSubs.push(sub);
        continue;
      }
      let next, ok, error;
      try {
        [next, ok, error] = collectOne(file, i, sub, manifest, fm.id || null);
      } catch (e) {
        if (!(e instanceof BundleSwapError)) {
          throw e;
        }
        [next, ok, error] = [
          {
            ...sub,
          },
          false,
          `swap failed: ${e.message}`,
        ];
      }
      if (error) {
        fails.push(`${path.relative(REPO, file)}[${i}]: ${error}`);
        next = {
          ...sub,
        };
      }
      if (ok) {
        wrote++;
      } else if (next.submission_truth === "unavailable") {
        unavailable++;
      }
      if (!isDeepStrictEqual(next, sub)) {
        changed = true;
      }
      newSubs.push(next);
    }
    if (changed) {
      fm.submissions = newSubs;
      saveMd(file, match, fm);
    }
  }
  console.log(`Collected code for ${wrote} submissions; marked ${unavailable} as unavailable.`);
  if (fails.length) {
    console.error(`\n${fails.length} soft failure(s):`);
    for (const fail of fails) {
      console.error(`  ${fail}`);
    }
    return 1;
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
