#!/usr/bin/env node
/**
 * Retrieve a single wiki page by its id or path.
 *
 * Usage:
 *   get_page.mjs kernel-flash-attention-4         # by id
 *   get_page.mjs pr-cutlass-2472                   # by id
 *   get_page.mjs wiki/kernels/flash-attention-4.md # by path
 *   get_page.mjs kernel-flash-attention-4 --body-only
 *   get_page.mjs kernel-flash-attention-4 --frontmatter-only
 *   get_page.mjs kernel-flash-attention-4 --follow-sources
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  findPage,
  INCLUDE_CODE_EXTS,
  listFiles,
  resolveArtifactDir,
  splitFrontmatter,
  WIKI_ROOT,
} from "./_corpus.mjs";
import { stringify } from "./_yaml.mjs";

const USAGE = `usage: get_page.mjs [-h] [--body-only] [--frontmatter-only]
                     [--follow-sources] [--include-code]
                     lookup`;

function pageExcerpt(pageFile) {
  const content = readFileSync(pageFile, "utf8");
  const [, body] = splitFrontmatter(content);
  return { content, body: body ?? "" };
}

function printFollowSources(fm) {
  if (!fm || !Object.hasOwn(fm, "sources")) return;
  console.log();
  console.log("---");
  console.log("## Cited Sources (excerpts)");
  console.log();
  for (const sourceId of fm.sources ?? []) {
    const sourcePage = findPage(String(sourceId));
    if (!sourcePage) continue;
    const { body } = pageExcerpt(sourcePage);
    const excerpt = body.slice(0, 500).trim();
    console.log(`### ${sourceId}`);
    console.log(`\`${path.relative(WIKI_ROOT, sourcePage)}\``);
    console.log();
    console.log(excerpt);
    console.log();
  }
}

function printCode(pagePath, fm) {
  const { rel, abs, fallback } = resolveArtifactDir(pagePath, fm);
  if (!abs) {
    if (rel) {
      console.log();
      console.log(`*(artifact_dir '${rel}' not found on disk)*`);
    }
    return;
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(abs).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    console.log();
    console.log(`*(artifact_dir '${rel}' not found on disk)*`);
    return;
  }

  console.log();
  console.log("---");
  const suffix = fallback ? " (conventional path — artifact_dir not backfilled)" : "";
  console.log(`## Artifact Bundle: \`${rel}\`${suffix}`);
  console.log();

  for (const file of listFiles(abs)) {
    if (!INCLUDE_CODE_EXTS.has(path.extname(file).toLowerCase())) continue;
    const relative = path.relative(abs, file);
    console.log(`### \`${relative}\``);
    console.log();
    try {
      const size = statSync(file).size;
      let bytes = readFileSync(file);
      if (size > 200 * 1024) {
        console.log(`*(file is ${size} bytes; showing first 200 KiB)*`);
        bytes = bytes.subarray(0, 200 * 1024);
      }
      console.log("```" + (path.extname(file).slice(1) || ""));
      console.log(bytes.toString("utf8"));
      console.log("```");
      console.log();
    } catch (error) {
      console.log(`*(could not read: ${error.message})*`);
      console.log();
    }
  }
}

function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        "body-only": { type: "boolean" },
        "frontmatter-only": { type: "boolean" },
        "follow-sources": { type: "boolean" },
        "include-code": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    console.error(`get_page.mjs: error: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) {
    console.error("get_page.mjs: error: exactly one lookup is required");
    console.error(USAGE);
    process.exit(2);
  }

  const pagePath = findPage(positionals[0]);
  if (!pagePath) {
    console.error(`ERROR: No page found for '${positionals[0]}'`);
    process.exit(1);
  }

  const content = readFileSync(pagePath, "utf8");
  const [fm, body] = splitFrontmatter(content);

  if (values["frontmatter-only"]) {
    if (fm) {
      console.log(
        stringify(fm, {
          lineWidth: 0,
          indentSeq: false,
          sortMapEntries: false,
          singleQuote: true,
        }),
      );
    }
    return;
  }
  if (values["body-only"]) {
    console.log(body ?? "");
    return;
  }

  console.log(`# ${path.relative(WIKI_ROOT, pagePath)}`);
  console.log();
  console.log(content);

  if (values["follow-sources"]) printFollowSources(fm);
  if (values["include-code"]) printCode(pagePath, fm);
}

main();
