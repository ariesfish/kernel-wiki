#!/usr/bin/env node
/**
 * Text search across wiki bodies and source PR descriptions.
 *
 * Usage:
 *   grep_wiki.mjs "tcgen05" --only wiki
 *   grep_wiki.mjs "two-CTA" --only wiki
 *   grep_wiki.mjs "ping-pong" --context 3
 *   grep_wiki.mjs "nvfp4 block_scale" --any     # match if ANY word appears
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ARTIFACT_SEARCH_EXTS, listFiles, WIKI_ROOT, wikiPath } from "./lib/corpus.mjs";

const USAGE = `usage: grep_wiki.mjs [-h] [--only {wiki,sources,all,artifacts}]
                       [--context CONTEXT] [--any] [--limit LIMIT]
                       [--files-only] [--ext EXT]
                       patterns [patterns ...]`;

const SCOPES = {
  wiki: ["wiki"],
  sources: ["sources"],
  all: ["wiki", "sources"],
  artifacts: ["artifacts"],
};

function iterFiles(scope, extensions) {
  let subdirs = SCOPES[scope] ?? ["wiki", "sources"];
  const hasExtensions = extensions && extensions.size > 0;
  if (hasExtensions && !subdirs.includes("artifacts") && scope !== "wiki" && scope !== "sources") {
    subdirs = [...subdirs, "artifacts"];
  }

  const searchExts =
    scope === "artifacts" && !hasExtensions
      ? ARTIFACT_SEARCH_EXTS
      : new Set([".md", ...(hasExtensions ? extensions : [])]);

  const files = [];
  for (const subdir of subdirs) {
    for (const file of listFiles(wikiPath(subdir))) {
      if (searchExts.has(path.extname(file).toLowerCase())) files.push(file);
    }
  }
  return files;
}

function splitLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function grepFile(file, patterns, context, anyMatch) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = splitLines(text);
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const matched = anyMatch
      ? patterns.some((pattern) => pattern.test(lines[i]))
      : patterns.every((pattern) => pattern.test(lines[i]));
    if (!matched) continue;

    const start = Math.max(0, i - context);
    const end = Math.min(lines.length, i + context + 1);
    const snippet = [];
    for (let j = start; j < end; j++) {
      snippet.push(`${j + 1}${j === i ? "→" : ":"} ${lines[j]}`);
    }
    results.push([i + 1, snippet.join("\n")]);
  }
  return results;
}

function parseIntArg(value, flag, fallback) {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(String(value))) {
    console.error(`grep_wiki.mjs: error: argument ${flag}: invalid int value: '${value}'`);
    process.exit(2);
  }
  return Number.parseInt(value, 10);
}

function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        only: { type: "string" },
        context: { type: "string" },
        any: { type: "boolean" },
        limit: { type: "string" },
        "files-only": { type: "boolean" },
        ext: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    console.error(`grep_wiki.mjs: error: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length === 0) {
    console.error("grep_wiki.mjs: error: at least one pattern is required");
    console.error(USAGE);
    process.exit(2);
  }

  const only = values.only ?? "all";
  if (!Object.hasOwn(SCOPES, only)) {
    console.error(`grep_wiki.mjs: error: --only must be one of ${Object.keys(SCOPES).join(", ")}`);
    process.exit(2);
  }
  const context = parseIntArg(values.context, "--context", 1);
  const limit = parseIntArg(values.limit, "--limit", 20);

  const patterns = [];
  for (const source of positionals) {
    try {
      patterns.push(new RegExp(source, "i"));
    } catch (error) {
      console.error(`ERROR: invalid regex ${JSON.stringify(source)}: ${error.message}`);
      console.error("       Hint: escape special chars ([](){}.*+?^$|\\) or quote the pattern.");
      process.exit(2);
    }
  }

  let extensions = null;
  if (values.ext) {
    extensions = new Set(
      values.ext
        .split(",")
        .map((value) => value.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean)
        .map((value) => `.${value}`),
    );
  }

  let matchedFiles = [];
  for (const file of iterFiles(only, extensions)) {
    const hits = grepFile(file, patterns, context, values.any === true);
    if (hits.length > 0) matchedFiles.push([file, hits]);
  }
  matchedFiles = matchedFiles.slice(0, limit);

  if (values["files-only"]) {
    for (const [file] of matchedFiles) console.log(path.relative(WIKI_ROOT, file));
    return;
  }

  if (matchedFiles.length === 0) {
    console.log("No matches.");
    return;
  }

  console.log(`# ${matchedFiles.length} file(s) match`);
  for (const [file, hits] of matchedFiles) {
    console.log();
    console.log(
      `## ${path.relative(WIKI_ROOT, file)}  (${hits.length} match${hits.length === 1 ? "" : "es"})`,
    );
    for (const [, snippet] of hits.slice(0, 5)) {
      console.log("```");
      console.log(snippet);
      console.log("```");
    }
  }
}

main();
