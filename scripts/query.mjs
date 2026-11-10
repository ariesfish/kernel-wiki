#!/usr/bin/env node
/**
 * Unified query tool for the Blackwell kernel wiki.
 *
 * Supports natural-language keyword queries, tag filters, repo filters, and
 * type filters. This is the Node.js port of the former scripts/query.py; the
 * CLI surface and output shape are unchanged.
 *
 * Usage:
 *   query.mjs "how to fuse gate-up GEMM"
 *   query.mjs --tag nvfp4 --type kernel
 *   query.mjs --repo cutlass --limit 20
 *   query.mjs --language cute-dsl
 *   query.mjs --symptom memory-bound
 */

import { parseArgs } from "node:util";

import { expandKeyword } from "./lib/aliases.mjs";
import { architectureMatchesFilter } from "./lib/architectures.mjs";
import { hasCode, loadIndexedPages, pageTypeOf } from "./lib/corpus.mjs";

const USAGE = `usage: query.mjs [-h] [--type TYPE] [--tag TAG] [--repo REPO]
                  [--language LANGUAGE] [--architecture ARCHITECTURE]
                  [--symptom SYMPTOM] [--confidence CONFIDENCE] [--has-code]
                  [--limit LIMIT] [--compact] [--paths-only]
                  [query ...]`;

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function scoreKeywordMatch(fm, body, keywords) {
  let score = 0;
  const titleText = String(fm.title ?? "").toLowerCase();
  const tagText = ["tags", "techniques", "hardware_features", "kernel_types", "languages", "aliases", "symptoms"]
    .flatMap((key) => asList(fm[key]).map((value) => String(value)))
    .join(" ")
    .toLowerCase();
  const bodyLower = body.toLowerCase();

  for (const keyword of keywords) {
    let best = 0;
    for (const variant of expandKeyword(keyword)) {
      const lowered = variant.toLowerCase();
      let variantScore = 0;
      if (titleText.includes(lowered)) variantScore += 10;
      if (tagText.includes(lowered)) variantScore += 5;
      const hits = bodyLower.split(lowered).length - 1;
      variantScore += Math.min(hits, 3);
      if (variantScore > best) best = variantScore;
    }
    score += best;
  }
  return score;
}

function filterPages(pages, options) {
  const out = [];
  for (const page of pages) {
    const { fm, path: rel } = page;
    const pageType = pageTypeOf(fm, rel);
    page._ptype = pageType;

    if (options.type && !pageType.endsWith(options.type) && pageType !== options.type) continue;

    if (options.tag) {
      const allTags = new Set();
      for (const key of ["tags", "techniques", "hardware_features", "kernel_types", "languages"]) {
        for (const value of asList(fm[key])) allTags.add(String(value).toLowerCase());
      }
      const variants = new Set(expandKeyword(options.tag).map((value) => value.toLowerCase()));
      if (![...allTags].some((tag) => variants.has(tag))) continue;
    }

    if (options.repo) {
      const repo = String(fm.repo ?? "").toLowerCase();
      if (!repo.includes(options.repo.toLowerCase())) continue;
    }

    if (options.language) {
      const languages = asList(fm.languages);
      const tags = asList(fm.tags);
      if (!languages.includes(options.language) && !tags.includes(options.language)) continue;
    }

    if (options.architecture) {
      if (
        !architectureMatchesFilter(
          asList(fm.architectures),
          String(fm.architecture_disposition ?? ""),
          options.architecture,
        )
      ) {
        continue;
      }
    }

    if (options.symptom && !asList(fm.symptoms).includes(options.symptom)) continue;

    if (options.confidence && String(fm.confidence ?? "") !== options.confidence) continue;

    if (options.hasCode && !hasCode(page.file, fm)) continue;

    out.push(page);
  }
  return out;
}

function architectureFilterExclusionCounts(pages, requested) {
  const normalized = String(requested).toLowerCase().replaceAll("_", "");
  if (["blackwell", "hopper", "ampere", "ada", "unknown"].includes(normalized)) return null;
  const familyOnly = pages.filter((page) => page.fm.architecture_disposition === "family").length;
  const unknown = pages.filter(
    (page) =>
      page.fm.architecture_disposition === "unknown" && asList(page.fm.architectures).length === 0,
  ).length;
  return [familyOnly, unknown];
}

function pyTruthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function pyRepr(value) {
  if (!Array.isArray(value)) return String(value);
  return `[${value
    .map((item) => (typeof item === "string" ? `'${item}'` : String(item)))
    .join(", ")}]`;
}

function formatResult(page, compact) {
  const { fm } = page;
  const title = fm.title ?? "Untitled";
  const rel = page.path;
  const id = fm.id ?? "";
  const pageType = page._ptype ?? "?";

  if (compact) return `  [${pageType}] ${id}: ${title}  (${rel})`;

  const lines = [`## ${title}`];
  lines.push(`- **id**: \`${id}\``);
  lines.push(`- **type**: \`${pageType}\``);
  lines.push(`- **path**: \`${rel}\``);
  if (Object.hasOwn(fm, "architectures")) lines.push(`- **architectures**: ${pyRepr(fm.architectures)}`);
  for (const key of ["confidence", "reproducibility"]) {
    if (Object.hasOwn(fm, key)) lines.push(`- **${key}**: ${fm[key]}`);
  }
  for (const key of ["tags", "techniques", "hardware_features", "kernel_types", "languages"]) {
    if (pyTruthy(fm[key])) lines.push(`- **${key}**: ${pyRepr(fm[key])}`);
  }
  if (Array.isArray(fm.performance_claims)) {
    for (const claim of fm.performance_claims.slice(0, 2)) {
      lines.push(
        `- **perf**: ${claim.value} ${claim.metric} on ${claim.gpu} ` +
          `(${claim.dtype}, ${claim.shape})`,
      );
    }
  }
  if (pyTruthy(fm.sources)) lines.push(`- **sources**: ${pyRepr(asList(fm.sources).slice(0, 5))}`);
  return lines.join("\n");
}

function parseLimit(value) {
  if (value === undefined) return 10;
  if (!/^-?\d+$/.test(String(value))) {
    console.error(`query.mjs: error: argument --limit: invalid int value: '${value}'`);
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
        type: { type: "string" },
        tag: { type: "string" },
        repo: { type: "string" },
        language: { type: "string" },
        architecture: { type: "string" },
        symptom: { type: "string" },
        confidence: { type: "string" },
        "has-code": { type: "boolean" },
        limit: { type: "string" },
        compact: { type: "boolean" },
        "paths-only": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    console.error(`query.mjs: error: ${error.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const options = {
    type: values.type,
    tag: values.tag,
    repo: values.repo,
    language: values.language,
    architecture: values.architecture,
    symptom: values.symptom,
    confidence: values.confidence,
    hasCode: values["has-code"] === true,
  };
  const limit = parseLimit(values.limit);

  const allPages = loadIndexedPages();
  let pages;
  let architectureStats = null;
  if (options.architecture) {
    const withoutArchitecture = { ...options, architecture: undefined };
    const eligible = filterPages(allPages, withoutArchitecture);
    pages = filterPages(eligible, options);
    architectureStats = architectureFilterExclusionCounts(eligible, options.architecture);
  } else {
    pages = filterPages(allPages, options);
  }

  if (architectureStats) {
    const [familyOnly, unknown] = architectureStats;
    console.error(
      `Exact architecture filter excluded ${familyOnly} family-only ` +
        `page(s) and ${unknown} architecture-unknown page(s); use ` +
        "--architecture blackwell or --architecture unknown for those broader sets.",
    );
  }

  const keywords = positionals
    .flatMap((query) => query.trim().split(/\s+/))
    .filter(Boolean);

  if (keywords.length > 0) {
    for (const page of pages) page._score = scoreKeywordMatch(page.fm, page.body, keywords);
    pages = pages.filter((page) => page._score > 0);
    pages.sort((a, b) => b._score - a._score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } else {
    pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  pages = pages.slice(0, limit);

  if (values["paths-only"]) {
    for (const page of pages) console.log(page.path);
    return;
  }

  if (pages.length === 0) {
    console.log("No matching pages.");
    return;
  }

  console.log(`# ${pages.length} result(s)`);
  console.log();
  for (const page of pages) {
    console.log(formatResult(page, values.compact === true));
    if (!values.compact) console.log();
  }
}

main();
