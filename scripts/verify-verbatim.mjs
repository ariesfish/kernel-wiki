#!/usr/bin/env node
/** Verify verbatim / upstream-patch assets; exit 2 means an inconclusive environment failure. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseMaintenance as parse } from "./lib/yaml.mjs";
import { isFile, isMain, REPO_ROOT, walkFiles } from "./compute-core-prs.mjs";
export { REPO_ROOT };
export const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
export const PATCH_INDEX_RE = /^(index )[0-9a-fA-F]+(\.\.)[0-9a-fA-F]+([^\n]*)$/gm;
export function canonicalizeUpstreamPatch(data) {
  return Buffer.from(
    Buffer.from(data).toString("latin1").replace(PATCH_INDEX_RE, "$1<OLD>$2<NEW>$3"),
    "latin1",
  );
}
export class EnvError extends Error {}
export const ENV_ERROR_HINTS = [
  "could not resolve host",
  "no such host",
  "temporary failure in name resolution",
  "unable to resolve",
  "connection refused",
  "connection reset",
  "connection timed out",
  "network is unreachable",
  "no route to host",
  "dial tcp",
  "i/o timeout",
  "context deadline exceeded",
  "request timed out",
  "error connecting",
  "failed to connect",
  "unable to connect",
  "couldn't connect",
  "cannot reach",
  "can't reach",
  "x509:",
  "tls handshake",
  "certificate signed by unknown authority",
  "certificate has expired",
  "self signed certificate",
  "proxy error",
  "proxyconnect",
  "authentication required",
  "you must authenticate",
  "you are not logged in",
  "not logged into",
  "bad credentials",
  "token expired",
  "sso enforcement",
  "rate limit",
  "api rate limit exceeded",
  "abuse detection",
  "secondary rate limit",
  "gh auth login",
  "http 401",
];
export function looksLikeEnvError(stderrText) {
  const low = stderrText.toLowerCase();
  return ENV_ERROR_HINTS.some((h) => low.includes(h));
}
export function runGh(args, { exec = execFileSync } = {}) {
  try {
    return Buffer.from(
      exec("gh", args, {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 ** 3,
      }),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new EnvError("gh CLI not found; install from https://cli.github.com/", {
        cause: error,
      });
    }
    const stderr = Buffer.from(error.stderr || error.message || "").toString("utf8");
    if (looksLikeEnvError(stderr)) {
      throw new EnvError(
        `gh ${args.join(" ")} environment failure: ${stderr.trim().slice(0, 200)}`,
        {
          cause: error,
        },
      );
    }
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim().slice(0, 200)}`, {
      cause: error,
    });
  }
}
export async function fetchVerbatim(
  upstreamRepo,
  upstreamSha,
  upstreamPath,
  { runGh: gh = runGh } = {},
) {
  const endpoint = `/repos/${upstreamRepo}/contents/${upstreamPath}?ref=${upstreamSha}`;
  const data = JSON.parse(await gh(["api", endpoint]));
  if (!Object.hasOwn(data, "content")) {
    throw new Error(`no content in response for ${upstreamRepo}:${upstreamPath}@${upstreamSha}`);
  }
  return Buffer.from(data.content, "base64");
}
export async function fetchUpstreamPatch(
  upstreamRepo,
  prNumber,
  expectedSha = null,
  { runGh: gh = runGh } = {},
) {
  if (expectedSha) {
    const prData = JSON.parse(await gh(["api", `/repos/${upstreamRepo}/pulls/${prNumber}`]));
    const mergeSha = prData.merge_commit_sha || "";
    if (!(mergeSha && mergeSha.startsWith(expectedSha))) {
      const headSha = prData.head?.sha || "";
      throw new Error(
        `upstream_sha '${expectedSha}' does not prefix-match merge_commit_sha=${mergeSha.slice(0, 12)}... (head.sha=${headSha.slice(0, 12)}... shown for reference; not accepted) for ${upstreamRepo}#${prNumber}; the PR was amended upstream`,
      );
    }
  }
  return Buffer.from(await gh(["pr", "diff", String(prNumber), "-R", upstreamRepo]));
}
export const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;
export const PR_ID_RE = /^pr-[a-z0-9-]+-(\d+)$(?![\s\S])/;
export const PR_FILENAME_RE = /PR[_-](\d+)/i;
export const PR_DIR_RE = /^PR-(\d+)$(?![\s\S])/;
export function resolvePrNumber(bundleRoot, prov, localPath) {
  return (
    PR_DIR_RE.exec(path.basename(bundleRoot))?.[1] ||
    PR_ID_RE.exec(prov?.source_pr_id || "")?.[1] ||
    PR_URL_RE.exec(prov?.origin_url || "")?.[1] ||
    PR_FILENAME_RE.exec(localPath)?.[1] ||
    null
  );
}
export function* iterBundles(scope, root = REPO_ROOT) {
  if (scope) {
    yield path.resolve(scope);
    return;
  }
  for (const prov of walkFiles(path.join(root, "artifacts"))) {
    if (path.basename(prov) === "PROVENANCE.yaml") {
      yield path.dirname(prov);
    }
  }
}
export function relToRepo(p, root = REPO_ROOT) {
  const rel = path.relative(root, path.resolve(p));
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? String(p) : rel;
}
export async function verifyBundle(bundleRoot, options = {}) {
  const root = options.root || REPO_ROOT;
  const rel = (p) => relToRepo(p, root);
  const provPath = path.join(bundleRoot, "PROVENANCE.yaml");
  if (!isFile(provPath)) {
    return [[`${rel(bundleRoot)}: missing PROVENANCE.yaml`], []];
  }
  let prov;
  try {
    prov = parse(readFileSync(provPath, "utf8")) || {};
  } catch (error) {
    if (typeof error.errno === "number") {
      throw new EnvError(`${rel(provPath)}: ${error.message}`);
    }
    return [[`${rel(provPath)}: YAML parse error: ${error.message}`], []];
  }
  const errors = [],
    envErrors = [];
  for (const entry of prov.files || []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const mode = entry.mode;
    if (!["verbatim", "upstream-patch"].includes(mode) || entry.size_cap_truncated) {
      continue;
    }
    const lp = entry.local_path;
    if (!lp) {
      continue;
    }
    const localPath = path.join(bundleRoot, lp);
    const label = `${rel(bundleRoot)}/${lp}`;
    if (!isFile(localPath)) {
      errors.push(`${label}: local file missing`);
      continue;
    }
    const localBytes = readFileSync(localPath);
    const fileUpstreamRepo = entry.upstream_repo || prov.upstream_repo;
    const fileUpstreamSha = entry.upstream_sha || prov.upstream_sha;
    let upstreamBytes;
    try {
      if (mode === "verbatim") {
        if (!(fileUpstreamRepo && fileUpstreamSha && entry.upstream_path)) {
          errors.push(
            `${label}: verbatim mode requires upstream_repo + upstream_sha + upstream_path`,
          );
          continue;
        }
        upstreamBytes = await (options.fetchVerbatim || fetchVerbatim)(
          fileUpstreamRepo,
          fileUpstreamSha,
          entry.upstream_path,
          options,
        );
      } else {
        const prNum = resolvePrNumber(bundleRoot, prov, lp);
        if (!prNum) {
          errors.push(
            `${label}: upstream-patch mode could not resolve a PR number from source_pr_id, origin_url, patch filename, or bundle directory name`,
          );
          continue;
        }
        if (!fileUpstreamSha) {
          errors.push(
            `${label}: upstream-patch mode requires upstream_sha (bundle-level or per-file) to pin the verification to the exact upstream state`,
          );
          continue;
        }
        upstreamBytes = await (options.fetchUpstreamPatch || fetchUpstreamPatch)(
          fileUpstreamRepo,
          prNum,
          fileUpstreamSha,
          options,
        );
      }
    } catch (error) {
      if (error instanceof EnvError) {
        envErrors.push(`${label}: environment failure: ${error.message}`);
      } else {
        errors.push(`${label}: upstream fetch failed: ${error.message}`);
      }
      continue;
    }
    const comparableLocal =
      mode === "upstream-patch" ? canonicalizeUpstreamPatch(localBytes) : localBytes;
    const comparableUpstream =
      mode === "upstream-patch"
        ? canonicalizeUpstreamPatch(upstreamBytes)
        : Buffer.from(upstreamBytes);
    if (!comparableLocal.equals(comparableUpstream)) {
      const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      errors.push(
        `${label}: ${mode === "upstream-patch" ? "canonicalized upstream-patch" : mode} mismatch (local ${sha(localBytes)}..., upstream ${sha(upstreamBytes)}...)`,
      );
    }
  }
  return [errors, envErrors];
}
export async function main(argv = process.argv.slice(2), options = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        strict: {
          type: "boolean",
        },
        bundle: {
          type: "string",
        },
        help: {
          type: "boolean",
          short: "h",
        },
      },
    });
    if (values.help) {
      console.log(
        "Usage: verify-verbatim.mjs [--strict] [--bundle DIR]\nVerify verbatim and upstream-patch bytes against upstream (default: warn-only).",
      );
      return 0;
    }
    const root = options.root || REPO_ROOT;
    try {
      if (!statSync(path.join(root, "artifacts")).isDirectory()) {
        throw new Error();
      }
    } catch {
      console.log("No artifacts/ directory; nothing to verify.");
      return 0;
    }
    const errors = [],
      envErrors = [];
    let checked = 0;
    for (const bundle of iterBundles(values.bundle, root)) {
      checked++;
      const [errs, envErrs] = await (options.verifyBundle || verifyBundle)(bundle, options);
      errors.push(...errs);
      envErrors.push(...envErrs);
    }
    console.log(`Verified ${checked} bundle(s).`);
    for (const e of envErrors) {
      console.error(`  ENV: ${e}`);
    }
    if (envErrors.length) {
      console.error(`\n${envErrors.length} environment failure(s).`);
    }
    for (const e of errors) {
      console.error(`  WARN: ${e}`);
    }
    if (errors.length) {
      console.error(`\n${errors.length} mismatch(es) found.`);
    }
    if (envErrors.length) {
      return 2;
    }
    if (errors.length) {
      return values.strict ? 1 : 0;
    }
    console.log("All verbatim/upstream-patch assets match upstream.");
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }
}
if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
