#!/usr/bin/env node
/** Generate query index pages from source and wiki frontmatter. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMaintenance as parse } from "./lib/yaml.mjs";
import { ARCHITECTURE_FAMILY_PREFIXES } from "./lib/pr-policy.mjs";
export { ARCHITECTURE_FAMILY_PREFIXES };
export let REPO_ROOT, SOURCES_DIR, WIKI_DIR, QUERIES_DIR;
export function configureRoot(
  root = process.env.BLACKWELL_WIKI_ROOT || fileURLToPath(new URL("../", import.meta.url)),
) {
  REPO_ROOT = path.resolve(root);
  SOURCES_DIR = path.join(REPO_ROOT, "sources");
  WIKI_DIR = path.join(REPO_ROOT, "wiki");
  QUERIES_DIR = path.join(REPO_ROOT, "queries");
}
configureRoot();
const yamlOptions = {
  maxAliasCount: -1,
};
const yaml = (source) => parse(source, yamlOptions);
const text = (filename) => readFileSync(filename, "utf8").replace(/\r\n?/g, "\n");
const mapping = (value) =>
  value != null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const get = (object, key, fallback = "") => (Object.hasOwn(object, key) ? object[key] : fallback);
const str = (value) =>
  value == null
    ? "None"
    : value instanceof Date
      ? value.toISOString().replace(/T00:00:00\.000Z$/, "")
      : String(value);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values) => [...values].sort(compare);
const byTitle = (pages) => [...pages].sort((a, b) => compare(get(a, "title"), get(b, "title")));
function* walk(directory) {
  if (!existsSync(directory)) {
    return;
  }
  for (const name of readdirSync(directory).sort()) {
    const filename = path.join(directory, name);
    yield filename;
    if (lstatSync(filename).isDirectory()) {
      yield* walk(filename);
    }
  }
}
const tags = (category) => {
  const filename = path.join(REPO_ROOT, "data/tags.yaml");
  return new Set(existsSync(filename) ? yaml(text(filename))[category] || [] : []);
};
const header = (title) => [`# Query: ${title}`, "", "> Auto-generated. Do not edit manually.", ""];
const output = (lines) => lines.join("\n") + "\n";
const add = (map, key, page) => {
  (map[key] ||= []).push(page);
};
const link = (page, fallback = "Untitled") =>
  `[${get(page, "title", fallback)}](${qlink(page._path)})`;
function links(pages) {
  const seen = new Set(),
    result = [];
  for (const page of pages) {
    const id = get(page, "id", get(page, "_path"));
    if (!seen.has(id)) {
      seen.add(id);
      result.push(link(page, id));
    }
  }
  return result.join(", ");
}
export function extractFrontmatter(filepath) {
  const match = /^---\s*\r?\n(.*?)\r?\n---\s*\r?\n/s.exec(text(filepath));
  if (!match) {
    return null;
  }
  try {
    return yaml(match[1]);
  } catch {
    return null;
  }
}
export function qlink(filename) {
  return `../${filename}`;
}
export function loadValidLanguages() {
  return tags("languages");
}
export function collectAllPages() {
  const pages = [],
    errors = [];
  for (const directory of [SOURCES_DIR, WIKI_DIR]) {
    for (const filename of sorted([...walk(directory)].filter((p) => p.endsWith(".md")))) {
      const fm = extractFrontmatter(filename),
        rel = path.relative(REPO_ROOT, filename).split(path.sep).join("/");
      if (fm == null) {
        errors.push(`${rel}: missing or unparseable frontmatter`);
      } else if (!mapping(fm)) {
        errors.push(
          `${rel}: frontmatter is ${Array.isArray(fm) ? "list" : typeof fm === "string" ? "str" : typeof fm === "boolean" ? "bool" : typeof fm === "number" ? (Number.isInteger(fm) ? "int" : "float") : "date"}, not a mapping`,
        );
      } else {
        pages.push({
          ...fm,
          _path: rel,
          _dir: path.relative(REPO_ROOT, directory).split(path.sep).join("/"),
        });
      }
    }
  }
  if (errors.length) {
    console.log(`ERROR: ${errors.length} files have missing/unparseable frontmatter:`);
    for (const error of errors) {
      console.log(`  ${error}`);
    }
    console.log("Run node scripts/validate.mjs first to fix these files.");
    const error = new Error("missing or unparseable frontmatter");
    error.exitCode = 1;
    throw error;
  }
  return pages;
}
export function generateByProblem(pages) {
  const ids = new Map(pages.filter((p) => "id" in p).map((p) => [p.id, p]));
  const lines = [
    ...header("By Problem / Symptom"),
    "| Symptom | Pattern Page | Candidate Techniques | Sources |",
    "|---------|-------------|---------------------|---------|",
  ];
  for (const p of byTitle(pages.filter((p) => p.type === "pattern"))) {
    const techniques = (p.candidate_techniques || [])
      .map((id) => (ids.has(id) ? link(ids.get(id), id) : id))
      .join(", ");
    lines.push(
      `| ${(p.symptoms || []).join(", ")} | ${link(p)} | ${techniques} | ${(p.sources || []).length} sources |`,
    );
  }
  return output(lines);
}
export function generateByTechnique(pages) {
  const lines = [
    ...header("By Technique"),
    "| Technique | Tags | Architectures | Confidence | Reproducibility | Sources |",
    "|-----------|------|--------------|------------|-----------------|---------|",
  ];
  for (const p of byTitle(pages.filter((p) => p.type === "technique"))) {
    lines.push(
      `| ${link(p)} | ${(p.tags || []).slice(0, 4).join(", ")} | ${(p.architectures || []).join(", ")} | ${get(p, "confidence")} | ${get(p, "reproducibility")} | ${(p.sources || []).length} |`,
    );
  }
  return output(lines);
}
export function generateByHardwareFeature(pages) {
  const lines = header("By Hardware Feature"),
    vocabulary = tags("hardware_features"),
    features = Object.create(null);
  for (const p of pages) {
    const indexed = new Set();
    for (const feature of p.hardware_features || []) {
      add(features, feature, p);
      indexed.add(feature);
    }
    for (const tag of p.tags || []) {
      if (vocabulary.has(tag) && !indexed.has(tag)) {
        add(features, tag, p);
        indexed.add(tag);
      }
    }
  }
  for (const p of pages.filter((p) => p.type === "hardware")) {
    for (const tag of p.tags || []) {
      if (vocabulary.has(tag) && !(features[tag] || []).includes(p)) {
        add(features, tag, p);
      }
    }
  }
  lines.push("| Feature | Related Pages |", "|---------|--------------|");
  for (const feature of sorted(Object.keys(features))) {
    lines.push(`| \`${feature}\` | ${links(features[feature])} |`);
  }
  return output(lines);
}
export function generateByRepo(pages) {
  const lines = header("By Repository"),
    repos = Object.create(null);
  for (const p of pages) {
    if ("repo" in p && "pr" in p) {
      add(repos, p.repo, p);
    }
  }
  for (const repo of sorted(Object.keys(repos))) {
    const prs = [...repos[repo]].sort((a, b) => compare(str(get(b, "date")), str(get(a, "date"))));
    lines.push(
      `<a id="${repo.toLowerCase().replaceAll("/", "")}"></a>`,
      `## ${repo}`,
      `${prs.length} PRs`,
      "",
      "| PR | Title | Date | Techniques | Tags |",
      "|-----|-------|------|------------|------|",
    );
    for (const p of prs) {
      lines.push(
        `| [#${get(p, "pr", "?")}](${qlink(p._path)}) | ${get(p, "title", "Untitled")} | ${str(get(p, "date"))} | ${[...new Set(p.techniques || [])].slice(0, 3).join(", ")} | ${[...new Set(p.tags || [])].slice(0, 3).join(", ")} |`,
      );
    }
    lines.push("");
  }
  return output(lines);
}
export function generateByKernelType(pages) {
  const lines = [...header("By Kernel Type"), "| Kernel Type | Pages |", "|-------------|-------|"];
  const vocabulary = tags("kernel_types"),
    types = Object.create(null);
  for (const p of pages) {
    if (p.kernel_types?.length) {
      for (const type of p.kernel_types) {
        add(types, type, p);
      }
    } else if (p.type == null || p.type === "kernel") {
      for (const tag of p.tags || []) {
        if (vocabulary.has(tag)) {
          add(types, tag, p);
        }
      }
    }
  }
  for (const type of sorted(Object.keys(types))) {
    lines.push(`| \`${type}\` | ${links(types[type])} |`);
  }
  return output(lines);
}
export function generateByLanguage(pages) {
  const lines = header("By Language / DSL"),
    valid = loadValidLanguages(),
    data = Object.create(null);
  for (const lang of sorted(valid)) {
    data[lang] = {
      guide: null,
      consumers: [],
    };
  }
  for (const p of pages.filter((p) => p.type === "language")) {
    let primary = (p.tags || []).find((tag) => valid.has(tag));
    if (!primary && get(p, "id").startsWith("lang-") && valid.has(p.id.slice(5))) {
      primary = p.id.slice(5);
    }
    if (primary && primary in data) {
      data[primary].guide = p;
    }
  }
  for (const p of pages.filter((p) => p.type !== "language")) {
    if (p.languages?.length) {
      for (const lang of p.languages) {
        if (lang in data) {
          data[lang].consumers.push(p);
        }
      }
    } else {
      for (const tag of p.tags || []) {
        if (valid.has(tag)) {
          data[tag].consumers.push(p);
        }
      }
    }
  }
  lines.push("| Language | Guide | Related Pages |", "|----------|-------|--------------|");
  for (const lang of sorted(Object.keys(data))) {
    const { guide, consumers } = data[lang];
    if (!guide && !consumers.length) {
      continue;
    }
    lines.push(`| \`${lang}\` | ${guide ? link(guide, lang) : ""} | ${links(consumers)} |`);
  }
  return output(lines);
}
export function architectureIndexSets(pages) {
  const exact = {},
    familyOnly = {},
    unknown = [];
  for (const page of pages) {
    const architectures = page.architectures || [];
    const families = architectures.filter((architecture) =>
      Object.hasOwn(ARCHITECTURE_FAMILY_PREFIXES, architecture),
    );
    if (page.architecture_disposition === "family" || families.length) {
      for (const family of families) {
        if (!Object.hasOwn(familyOnly, family)) {
          familyOnly[family] = [];
        }
        familyOnly[family].push(page);
      }
    }
    if (!architectures.length && page.architecture_disposition === "unknown") {
      unknown.push(page);
    }
    for (const architecture of architectures) {
      if (!Object.hasOwn(ARCHITECTURE_FAMILY_PREFIXES, architecture)) {
        if (!Object.hasOwn(exact, architecture)) {
          Object.defineProperty(exact, architecture, {
            value: [],
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        exact[architecture].push(page);
      }
    }
  }
  return [exact, familyOnly, unknown];
}
export function architecturePageTable(lines, pages) {
  lines.push("| Page | Path |", "|------|------|");
  for (const page of [...pages].sort((a, b) => compare(get(a, "_path"), get(b, "_path")))) {
    lines.push(`| ${link(page, get(page, "id", "Untitled"))} | \`${page._path}\` |`);
  }
  if (!pages.length) {
    lines.push("| _None_ | |");
  }
  lines.push("");
}
export function generateByArchitecture(pages) {
  const [exact, family, unknown] = architectureIndexSets(pages);
  const lines = [
    "# Query: By Architecture",
    "",
    "> Auto-generated. Do not edit manually. Exact sections contain only pages carrying that exact value; family-only pages and validated source-PR unknowns are intentionally separate. Non-PR sources with an empty architecture list have no validated unknown disposition and are outside the unknown lane.",
    "",
  ];
  for (const name of Object.keys(ARCHITECTURE_FAMILY_PREFIXES)) {
    const title = name[0].toUpperCase() + name.slice(1);
    lines.push(
      `## ${title} family-only`,
      "",
      `Pages with explicit generic ${title} evidence but no supported exact SM in that family.`,
      "",
    );
    architecturePageTable(lines, family[name] || []);
  }
  lines.push(
    "## Architecture unknown",
    "",
    "Source-PR pages whose validated evidence review found no family-level or exact architecture signal.",
    "",
  );
  architecturePageTable(lines, unknown);
  lines.push("## Exact architectures", "");
  for (const architecture of sorted(Object.keys(exact))) {
    lines.push(`### \`${architecture}\``, "");
    architecturePageTable(lines, exact[architecture]);
  }
  return output(lines);
}
export function main() {
  if (!existsSync(QUERIES_DIR)) {
    mkdirSync(QUERIES_DIR);
  }
  const pages = collectAllPages();
  console.log(`Collected ${pages.length} pages from sources/ and wiki/`);
  for (const [filename, generate] of Object.entries({
    "by-architecture.md": generateByArchitecture,
    "by-problem.md": generateByProblem,
    "by-technique.md": generateByTechnique,
    "by-hardware-feature.md": generateByHardwareFeature,
    "by-repo.md": generateByRepo,
    "by-kernel-type.md": generateByKernelType,
    "by-language.md": generateByLanguage,
  })) {
    writeFileSync(path.join(QUERIES_DIR, filename), generate(pages), "utf8");
    console.log(`  Generated queries/${filename}`);
  }
  console.log("Done.");
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error.exitCode !== 1) {
      throw error;
    }
    process.exitCode = 1;
  }
}
