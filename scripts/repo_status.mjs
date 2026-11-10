#!/usr/bin/env node
/** Print current corpus counts. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { listFiles, WIKI_ROOT } from "./lib/corpus.mjs";
import { parse } from "./lib/yaml.mjs";
function countFiles(...parts) {
  const root = path.join(WIKI_ROOT, ...parts);
  try {
    if (!statSync(root).isDirectory()) {
      return 0;
    }
  } catch {
    return 0;
  }
  return listFiles(root).filter((file) => file.endsWith(".md")).length;
}
function countTopLevelFiles(parts, extension) {
  const root = path.join(WIKI_ROOT, ...parts);
  let entries;
  try {
    entries = readdirSync(root, {
      withFileTypes: true,
    });
  } catch {
    return 0;
  }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(extension)).length;
}
function countPrsByRepo() {
  const root = path.join(WIKI_ROOT, "sources", "prs");
  const counts = new Map();
  let entries;
  try {
    entries = readdirSync(root, {
      withFileTypes: true,
    });
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    let files;
    try {
      files = readdirSync(path.join(root, entry.name), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    const count = files.filter(
      (file) => file.isFile() && file.name.startsWith("PR-") && file.name.endsWith(".md"),
    ).length;
    counts.set(entry.name, count);
  }
  return counts;
}
function countArtifactModes() {
  const counts = new Map();
  for (const file of listFiles(path.join(WIKI_ROOT, "artifacts"))) {
    if (path.basename(file) !== "PROVENANCE.yaml") {
      continue;
    }
    let mode = "unknown";
    try {
      const data = parse(readFileSync(file, "utf8")) ?? {};
      if (typeof data.asset_mode === "string" && data.asset_mode) {
        mode = data.asset_mode;
      }
    } catch {
      mode = "unknown";
    }
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }
  return counts;
}
function main() {
  const prCounts = countPrsByRepo();
  const artifactModes = countArtifactModes();
  const sourcePages = countFiles("sources");
  const wikiPages = countFiles("wiki");
  console.log("Corpus counts:");
  console.log(`  Indexed source/wiki pages: ${sourcePages + wikiPages}`);
  console.log(
    `  Source PR pages: ${[...prCounts.values()].reduce((sum, value) => sum + value, 0)}`,
  );
  console.log(`  Wiki synthesis pages: ${wikiPages}`);
  console.log(`  Blog summaries: ${countFiles("sources", "blogs")}`);
  console.log(`  Doc summaries: ${countFiles("sources", "docs")}`);
  console.log(`  Contest pages: ${countFiles("sources", "contests")}`);
  console.log(`  Candidate ledgers: ${countTopLevelFiles(["candidates"], ".yaml")}`);
  console.log(
    `  Artifact bundles: ${[...artifactModes.values()].reduce((sum, value) => sum + value, 0)}`,
  );
  console.log(`  Query indices: ${countTopLevelFiles(["queries"], ".md")}`);
  if (prCounts.size > 0) {
    console.log();
    console.log("Source PR pages by repo:");
    for (const [repo, count] of [...prCounts].sort((a, b) =>
      a[0].toLowerCase() < b[0].toLowerCase()
        ? -1
        : a[0].toLowerCase() > b[0].toLowerCase()
          ? 1
          : 0,
    )) {
      console.log(`  ${repo}: ${count}`);
    }
  }
  if (artifactModes.size > 0) {
    console.log();
    console.log("Artifact bundles by mode:");
    for (const [mode, count] of [...artifactModes].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )) {
      console.log(`  ${mode}: ${count}`);
    }
  }
}
main();
