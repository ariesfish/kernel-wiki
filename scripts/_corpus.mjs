/**
 * The one place that reads a wiki page from disk.
 *
 * query, get_page, and the status command share this module so frontmatter
 * parsing, page-id lookup, and artifact-bundle discovery cannot drift apart.
 * Maintenance tooling (scripts/validate.py) keeps its own parser because it
 * reports parse errors instead of silently skipping pages.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { WIKI_ROOT, wikiPath } from "./_root.mjs";
import { parse } from "./_yaml.mjs";

// The same expression the Python query tools used: a page must have a closing
// delimiter followed by a newline. A frontmatter-only file is not a page.
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)/;

// The id index must also see a page whose frontmatter has no body yet.
const FRONTMATTER_ONLY_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---/;

/** Split a page into [frontmatter, body]; no match yields [null, content]. */
export function splitFrontmatter(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return [null, content];
  let frontmatter;
  try {
    frontmatter = parse(match[1]);
  } catch {
    frontmatter = null;
  }
  return [frontmatter, match[2]];
}

export function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read one page. Returns null when the file disappears or is unreadable. */
export function readPage(file) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const [fm, body] = splitFrontmatter(content);
  return { file, rel: path.relative(WIKI_ROOT, file), fm, body, content };
}

function* walkMarkdown(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield full;
    }
  }
}

/** Yield every page under the given top-level directories. */
export function* iterPages({ subdirs = ["sources", "wiki"] } = {}) {
  for (const subdir of subdirs) {
    for (const file of walkMarkdown(wikiPath(subdir))) {
      const page = readPage(file);
      if (page) yield page;
    }
  }
}

/** Every parseable page with a mapping frontmatter, in a query-friendly shape. */
export function loadIndexedPages() {
  const pages = [];
  for (const page of iterPages()) {
    if (!isMapping(page.fm)) continue;
    pages.push({ file: page.file, path: page.rel, fm: page.fm, body: page.body ?? "" });
  }
  return pages;
}

let idIndex = null;

/** Read only the top-level id scalar; used to build the lookup index cheaply. */
function readPageId(file) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = FRONTMATTER_ONLY_RE.exec(content);
  if (!match) return null;
  const idLine = /^id:[ \t]*(.+?)[ \t]*$/m.exec(match[1]);
  if (!idLine) return null;
  let id = idLine[1];
  if (
    (id.startsWith("'") && id.endsWith("'")) ||
    (id.startsWith('"') && id.endsWith('"'))
  ) {
    id = id.slice(1, -1);
  }
  return id || null;
}

/** id -> absolute path, built once per process without parsing every body. */
export function pageIndex() {
  if (idIndex) return idIndex;
  idIndex = new Map();
  for (const file of walkMarkdown(wikiPath("wiki"))) {
    const id = readPageId(file);
    if (id && !idIndex.has(id)) idIndex.set(id, file);
  }
  for (const file of walkMarkdown(wikiPath("sources"))) {
    const id = readPageId(file);
    if (id && !idIndex.has(id)) idIndex.set(id, file);
  }
  return idIndex;
}

/** Find a page by relative/absolute path or by frontmatter id. */
export function findPage(lookup) {
  if (lookup.includes("/") || lookup.includes(path.sep) || lookup.endsWith(".md")) {
    const candidate = path.resolve(WIKI_ROOT, lookup);
    return existsSync(candidate) ? candidate : null;
  }
  const indexed = pageIndex().get(lookup);
  if (indexed) return indexed;

  // The fast index reads only the id line. Fall back to a full parse for an
  // unusual frontmatter shape (block scalar, folded value) that it missed.
  for (const page of iterPages({ subdirs: ["wiki", "sources"] })) {
    if (isMapping(page.fm) && page.fm.id === lookup) return page.file;
  }
  return null;
}

export function pageTypeOf(fm, rel) {
  if (fm && Object.hasOwn(fm, "type")) return `wiki-${fm.type}`;
  const parts = rel.split(/[\\/]/);
  if (parts[0] === "sources" && parts.length > 1) {
    return `source-${parts[1].replace(/s$/, "")}`;
  }
  return "unknown";
}

// Code-extension sets. query --has-code and get_page --include-code used to
// keep their own copies; they now share these. validate.py's ASSET_SOURCE_EXTS
// remains the authoring-side contract.
export const HAS_CODE_EXTS = new Set([
  ".cu", ".cuh", ".ptx", ".py", ".cpp", ".h", ".hpp", ".inl",
  ".pyx", ".cxx", ".cc", ".txt",
  ".sh", ".yaml", ".json",
]);

export const INCLUDE_CODE_EXTS = new Set([
  ".cu", ".cuh", ".ptx",
  ".cpp", ".cxx", ".cc", ".c",
  ".h", ".hpp", ".hxx", ".inl",
  ".py", ".pyx",
  ".patch",
  ".sh",
  ".md", ".yaml", ".yml", ".txt", ".json",
]);

export const ARTIFACT_SEARCH_EXTS = new Set([
  ".md",
  ".cu", ".cuh", ".ptx",
  ".cpp", ".cxx", ".cc", ".c",
  ".h", ".hpp", ".hxx", ".inl",
  ".py", ".pyx",
  ".patch",
  ".txt",
  ".sh",
  ".yaml", ".yml", ".json",
]);

function conventionalArtifactDir(pagePath, { blogCode = false } = {}) {
  const rel = path.relative(WIKI_ROOT, pagePath);
  const parts = rel.split(path.sep);
  if (parts[0] !== "sources") return null;
  const stem = path.basename(pagePath, ".md");
  if (parts[1] === "blogs" && parts.length === 3) {
    return wikiPath("artifacts", "blogs", stem, ...(blogCode ? ["code"] : []));
  }
  if (parts[1] === "contests" && parts.length === 4) {
    return wikiPath("artifacts", "contests", parts[2], stem);
  }
  if (parts[1] === "prs" && parts.length === 4) {
    return wikiPath("artifacts", "prs", parts[2], stem);
  }
  return null;
}

/**
 * Candidate bundle directories for a page. The explicit artifact_dir wins;
 * conventional locations follow. `--has-code` also infers a PR bundle from
 * frontmatter repo+pr fields, which covers pages outside the usual path.
 */
export function artifactCandidates(pagePath, fm, { blogCode = false, repoFallback = false } = {}) {
  const out = [];
  if (fm?.artifact_dir) out.push(path.resolve(WIKI_ROOT, String(fm.artifact_dir)));

  const conventional = conventionalArtifactDir(pagePath, { blogCode });
  if (conventional) out.push(conventional);

  if (repoFallback && fm?.repo != null && fm?.pr != null) {
    const repo = String(fm.repo).split("/").pop().toLowerCase();
    out.push(wikiPath("artifacts", "prs", repo, `PR-${fm.pr}`));
  }
  return out;
}

function hasAnyFile(dir, extensions) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasAnyFile(full, extensions)) return true;
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      return true;
    }
  }
  return false;
}

/** True when any candidate bundle holds at least one source file. */
export function hasCode(pagePath, fm) {
  for (const candidate of artifactCandidates(pagePath, fm, { blogCode: true, repoFallback: true })) {
    if (hasAnyFile(candidate, HAS_CODE_EXTS)) return true;
  }
  return false;
}

/**
 * Resolve the bundle get_page --include-code prints. Returns
 * {rel, abs, fallback}; abs is null when no bundle exists.
 */
export function resolveArtifactDir(pagePath, fm) {
  if (fm?.artifact_dir) {
    const rel = String(fm.artifact_dir);
    return { rel, abs: path.resolve(WIKI_ROOT, rel), fallback: false };
  }

  const candidate = conventionalArtifactDir(pagePath);
  if (!candidate) return { rel: null, abs: null, fallback: false };

  let isDirectory = false;
  try {
    isDirectory = statSync(candidate).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return { rel: null, abs: null, fallback: false };

  // A blog bundle with an explicit "no code" manifest is an empty shell.
  const parts = path.relative(WIKI_ROOT, pagePath).split(path.sep);
  if (parts[1] === "blogs") {
    const manifestPath = path.join(candidate, "MANIFEST.yaml");
    if (existsSync(manifestPath)) {
      try {
        const manifest = parse(readFileSync(manifestPath, "utf8")) ?? {};
        if (manifest.code_present === false) return { rel: null, abs: null, fallback: false };
      } catch {
        // Parse error: keep the bundle rather than hide it silently.
      }
    }
  }

  return { rel: path.relative(WIKI_ROOT, candidate), abs: candidate, fallback: true };
}

/** Recursively list files under a directory, sorted, with no symlink walk. */
export function listFiles(dir) {
  const out = [];
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  walk(dir);
  return out;
}

export { WIKI_ROOT, wikiPath };
