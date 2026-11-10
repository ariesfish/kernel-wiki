#!/usr/bin/env node
/** Validate every source/wiki frontmatter contract, audit receipt and asset bundle. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseMaintenance as parse } from "./lib/yaml.mjs";
import {
  ARCHITECTURE_FAMILY_PREFIXES, PRODUCT_ARCHITECTURE_MAPPINGS,
  SUPPORTED_EXACT_ARCHITECTURES, body_contract_errors, device_code_pattern_sha256,
} from "./lib/pr-policy.mjs";
export {
  ARCHITECTURE_FAMILY_PREFIXES, PRODUCT_ARCHITECTURE_MAPPINGS,
  SUPPORTED_EXACT_ARCHITECTURES, body_contract_errors, device_code_pattern_sha256,
};

export let REPO_ROOT, SOURCES_DIR, WIKI_DIR, DATA_DIR, ARTIFACTS_DIR, CANDIDATES_DIR;
export let PR_ARCHITECTURE_RECEIPT, PR_CAP_RECONSTRUCTION_RECEIPT;
/** Configure all corpus paths together; useful for isolated fixture roots. */
export function configure_root(root = process.env.BLACKWELL_WIKI_ROOT || fileURLToPath(new URL('../', import.meta.url))) {
  REPO_ROOT = path.resolve(root);
  SOURCES_DIR = path.join(REPO_ROOT, 'sources');
  WIKI_DIR = path.join(REPO_ROOT, 'wiki');
  DATA_DIR = path.join(REPO_ROOT, 'data');
  ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');
  CANDIDATES_DIR = path.join(REPO_ROOT, 'candidates');
  PR_ARCHITECTURE_RECEIPT = path.join(DATA_DIR, 'pr-architecture-evidence.json');
  PR_CAP_RECONSTRUCTION_RECEIPT = path.join(REPO_ROOT, 'audit/pr-file-cap-reconstruction.json');
}
configure_root();

export const REPRO_ORDER = ['concept', 'pseudocode', 'snippet', 'runnable', 'benchmarked'];
export function architecture_family_values(family) {
  const prefixes = ARCHITECTURE_FAMILY_PREFIXES[family];
  return new Set([family, ...SUPPORTED_EXACT_ARCHITECTURES.filter(arch => prefixes.some(prefix => arch.startsWith(prefix)))]);
}
export const HOPPER_ARCHITECTURES = architecture_family_values('hopper');
export const BLACKWELL_ARCHITECTURES = architecture_family_values('blackwell');
// Offline curated PTX ISA 9.3 fragments resolved on 2026-08-19.
export const PTX_ISA_CURATED_ANCHORS = new Set([
  'tensor-memory', 'tensorcore-5th-generation-instructions',
  'tcgen05-memory-alloc-manage-instructions',
  'parallel-synchronization-and-communication-instructions-clusterlaunchcontrol-try-cancel',
  'parallel-synchronization-and-communication-instructions-clusterlaunchcontrol-query-cancel',
]);
export const FILE_SIZE_CAP_BYTES = 1024 * 1024;
export const BUNDLE_SIZE_CAP_BYTES = 5 * 1024 * 1024;
export const ASSET_SOURCE_EXTS = new Set([
  '.cu', '.cuh', '.ptx', '.cpp', '.h', '.hpp', '.py', '.pyx', '.patch', '.inl', '.txt', '.sh', '.yaml', '.json',
]);

const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Set) && !(value instanceof Map);
const truth = value => (Boolean(value) || typeof value === 'number' && Number.isNaN(value)) && (!Array.isArray(value) || value.length > 0) && (!mapping(value) || Object.keys(value).length > 0) && (!(value instanceof Set || value instanceof Map) || value.size > 0);
const get = (object, key, fallback = null) => Object.hasOwn(object, key) ? object[key] : fallback;
const text = filename => readFileSync(filename, 'utf8').replace(/\r\n?/g, '\n');
const yaml_options = { maxAliasCount: -1 };
const yaml = source => parse(source, yaml_options);
const relpath = filename => path.relative(REPO_ROOT, filename).split(path.sep).join('/');
const hash = value => createHash('sha256').update(value).digest('hex');
const difference = (left, right) => [...left].filter(value => !right.has(value));
const intersection = (left, right) => [...left].filter(value => right.has(value));
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const typename = value => value == null ? 'NoneType' : Array.isArray(value) ? 'list' : mapping(value) ? 'dict' : typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? Number.isInteger(value) ? 'int' : 'float' : typeof value === 'string' ? 'str' : value instanceof Date ? 'date' : typeof value;
const str = value => value == null ? 'None' : value === true ? 'True' : value === false ? 'False' : value instanceof Date ? value.toISOString().replace(/T00:00:00\.000Z$/, '') : typeof value === 'object' ? repr(value) : String(value);
function repr(value) {
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replace(/\\/g, '\\\\').replaceAll(quote, `\\${quote}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + quote;
  }
  if (Array.isArray(value)) return `[${value.map(repr).join(', ')}]`;
  if (value instanceof Set) return value.size ? `{${[...value].map(repr).join(', ')}}` : 'set()';
  if (mapping(value)) return `{${Object.entries(value).map(([key, item]) => `${repr(key)}: ${repr(item)}`).join(', ')}}`;
  return str(value);
}
const tuple = values => `(${values.map(repr).join(', ')}${values.length === 1 ? ',' : ''})`;
const tuple_compare = (left, right) => {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length - right.length;
};
const tuple_list = values => `[${values.map(tuple).join(', ')}]`;
function is_file(filename) { try { return statSync(filename).isFile(); } catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return false; throw error; } }
function is_dir(filename) { try { return statSync(filename).isDirectory(); } catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return false; throw error; } }
function children(directory) {
  if (!is_dir(directory)) return [];
  return readdirSync(directory).sort().map(name => path.join(directory, name));
}
function* walk(directory) {
  for (const filename of children(directory)) {
    yield filename;
    if (is_dir(filename) && !lstatSync(filename).isSymbolicLink()) yield* walk(filename);
  }
}
const markdown = directory => sorted([...walk(directory)].filter(filename => path.basename(filename).endsWith('.md')));
const pr_pages = directory => sorted([...walk(directory)].filter(filename => /^PR-.*\.md$/.test(path.basename(filename))));
const ledgers = () => children(CANDIDATES_DIR).filter(filename => filename.endsWith('.yaml'));
function resolved(filename) {
  filename = path.resolve(filename);
  try { return realpathSync(filename); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const parent = path.dirname(filename);
    return parent === filename ? filename : path.join(resolved(parent), path.basename(filename));
  }
}
const contains = (root, filename) => filename === root || filename.startsWith(root + path.sep);
const canonical_json = value => {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : mapping(item) ? Object.fromEntries(sorted(Object.keys(item)).map(key => [key, canonical(item[key])])) : item;
  return JSON.stringify(canonical(value ?? null)).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
};

export function load_yaml_file(filename) { return yaml(text(filename)); }

export function validate_alias_contract(raw = null) {
  const errors = [];
  if (raw === null) {
    try {
      raw = parse(text(path.join(DATA_DIR, 'aliases.yaml')), { ...yaml_options, mapAsMap: true });
      if (!truth(raw)) raw = {};
    }
    catch (error) { return [`data/aliases.yaml: could not load canonical aliases (${error.message})`]; }
  }
  if (!mapping(raw) && !(raw instanceof Map)) return ['data/aliases.yaml: top level must be a mapping'];
  const aliases = new Map();
  for (const [canonical, variants] of raw instanceof Map ? raw : Object.entries(raw)) {
    if (typeof canonical !== 'string' || !canonical.trim()) {
      errors.push('data/aliases.yaml: canonical terms must be non-empty strings');
      continue;
    }
    if (variants != null && !Array.isArray(variants)) {
      errors.push(`data/aliases.yaml::${canonical}: aliases must be a list`);
      continue;
    }
    for (const value of [canonical, ...(variants || [])]) {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`data/aliases.yaml::${canonical}: aliases must be non-empty strings`);
        continue;
      }
      const normalized = value.toLowerCase(), previous = aliases.get(normalized);
      if (previous != null && previous !== canonical) errors.push(`data/aliases.yaml: ${repr(value)} maps to both ${repr(previous)} and ${repr(canonical)}`);
      else aliases.set(normalized, canonical);
    }
  }
  for (const [product, [expected_architecture]] of Object.entries(PRODUCT_ARCHITECTURE_MAPPINGS)) {
    const actual = aliases.get(product);
    if (actual != null && actual.toLowerCase() !== expected_architecture) errors.push(`data/aliases.yaml: product ${repr(product)} resolves to ${repr(actual)}; pr_policy requires ${repr(expected_architecture)}`);
  }
  for (const [family, prefixes] of Object.entries(ARCHITECTURE_FAMILY_PREFIXES)) {
    if (prefixes.length <= 1) continue;
    const actual = aliases.get(family);
    if (actual != null && actual.toLowerCase() !== family) errors.push(`data/aliases.yaml: architecture family ${repr(family)} resolves to exact term ${repr(actual)}`);
  }
  return errors;
}

export function changed_file_inventory_errors(fm, rel = 'source-pr') {
  const errors = [];
  const total = get(fm, 'changed_files_count'), enumerated = get(fm, 'changed_files_enumerated_count');
  const listing_complete = get(fm, 'changed_files_listing_complete'), displayed = fm.changed_paths || [];
  const display_complete = get(fm, 'changed_paths_complete');
  const evidence_count = get(fm, 'changed_files_evidence_count'), evidence_complete = get(fm, 'changed_files_evidence_complete');
  const evidence_method = get(fm, 'changed_files_evidence_method'), evidence_receipt = get(fm, 'changed_files_evidence_receipt');
  if (enumerated == null && listing_complete == null) return errors;
  if (!Number.isInteger(total) || total < 0) return [`${rel}: changed_files_count must be a non-negative integer`];
  if (!Number.isInteger(enumerated) || enumerated < 0) return [`${rel}: changed_files_enumerated_count must be a non-negative integer`];
  if (typeof listing_complete !== 'boolean') return [`${rel}: changed_files_listing_complete must be boolean`];
  if (enumerated > total) errors.push(`${rel}: changed_files_enumerated_count cannot exceed changed_files_count`);
  if (listing_complete !== (enumerated === total)) errors.push(`${rel}: changed_files_listing_complete must equal (changed_files_enumerated_count == changed_files_count)`);
  const evidence_fields = [evidence_count, evidence_complete, evidence_method, evidence_receipt];
  if (evidence_fields.some(value => value != null)) {
    if (evidence_fields.some(value => value == null)) errors.push(`${rel}: reconstructed evidence count/completeness/method/receipt must be supplied together`);
    else if (!Number.isInteger(evidence_count) || evidence_count < enumerated || evidence_count > total) errors.push(`${rel}: changed_files_evidence_count must be an integer between enumerated and total counts`);
    else {
      // Python compares booleans to 0/1 here, without imposing a type check.
      if (!(evidence_complete === (evidence_count === total) || evidence_complete === Number(evidence_count === total))) errors.push(`${rel}: changed_files_evidence_complete must equal (changed_files_evidence_count == changed_files_count)`);
      if (evidence_method !== 'github-pull-diff') errors.push(`${rel}: changed_files_evidence_method must be github-pull-diff`);
      if (evidence_receipt !== 'audit/pr-file-cap-reconstruction.json') errors.push(`${rel}: changed_files_evidence_receipt must name the committed cap reconstruction receipt`);
    }
  }
  const effective = Number.isInteger(evidence_count) || typeof evidence_count === 'boolean' ? Number(evidence_count) : enumerated;
  if (!Array.isArray(displayed)) errors.push(`${rel}: changed_paths must be a list`);
  else if (displayed.length > effective) errors.push(`${rel}: changed_paths cannot exceed the evaluated changed-file count`);
  if (display_complete === true && (!listing_complete || displayed.length !== total)) errors.push(`${rel}: changed_paths_complete requires a complete listing and every path`);
  return errors;
}

export function cap_reconstruction_page_errors(fm, row, rel = 'source-pr') {
  if (get(fm, 'changed_files_evidence_method') == null) return [];
  const errors = [];
  const expected = {
    changed_files_count: get(row, 'authoritative_changed_files'), changed_files_enumerated_count: get(row, 'files_api_enumerated'),
    changed_files_listing_complete: get(row, 'enumeration_complete'), changed_files_evidence_count: get(row, 'full_diff_paths'),
    changed_files_evidence_complete: get(row, 'full_diff_complete'), changed_files_evidence_method: 'github-pull-diff',
    changed_files_evidence_receipt: 'audit/pr-file-cap-reconstruction.json', upstream_files_sha256: get(row, 'policy_files_sha256'),
  };
  for (const [field, value] of Object.entries(expected)) if (!isDeepStrictEqual(get(fm, field), value)) errors.push(`${rel}: cap reconstruction receipt mismatch in ${field}`);
  const policy = row.full_policy || {}, scope = fm.scope_evidence || {};
  if (get(fm, 'scope_disposition') !== get(policy, 'disposition')) errors.push(`${rel}: cap reconstruction receipt mismatch in scope disposition`);
  if (get(scope, 'rule') !== get(policy, 'rule')) errors.push(`${rel}: cap reconstruction receipt mismatch in scope rule`);
  if (!isDeepStrictEqual(get(scope, 'paths'), get(policy, 'evidence_paths'))) errors.push(`${rel}: cap reconstruction receipt mismatch in scope paths`);
  if (scope.path_source !== 'github-pull-diff') errors.push(`${rel}: reconstructed scope paths must name github-pull-diff`);
  return errors;
}

export function cap_complete_file_evidence_errors(row, rel = 'cap reconstruction row') {
  const errors = [], records = row.complete_file_evidence;
  if (!Array.isArray(records)) return [`${rel}: complete_file_evidence must be a list`];
  const seen = new Set(), expected_pattern = device_code_pattern_sha256();
  for (const [index, record] of records.entries()) {
    const prefix = `${rel}: complete_file_evidence[${index}]`;
    if (!mapping(record)) { errors.push(`${prefix} must be a mapping`); continue; }
    const filename = record.path;
    if (typeof filename !== 'string' || !filename.endsWith('.cu')) errors.push(`${prefix}.path must name a .cu file`);
    else if (seen.has(filename)) errors.push(`${prefix}.path duplicates ${filename}`);
    else seen.add(filename);
    if (!/^[0-9a-f]{64}$/.test(str(get(record, 'sha256', '')))) errors.push(`${prefix}.sha256 must be a lowercase SHA-256 digest`);
    if (typeof record.device_signal !== 'boolean') errors.push(`${prefix}.device_signal must be boolean`);
    if (record.device_pattern_sha256 !== expected_pattern) errors.push(`${prefix}.device_pattern_sha256 is stale`);
  }
  return errors;
}

export function validate_cap_reconstruction_receipt() {
  if (!is_file(PR_CAP_RECONSTRUCTION_RECEIPT)) return ['audit/pr-file-cap-reconstruction.json: required receipt is missing'];
  let receipt;
  try { receipt = JSON.parse(text(PR_CAP_RECONSTRUCTION_RECEIPT)); }
  catch (error) { return [`audit/pr-file-cap-reconstruction.json: cannot parse receipt: ${error.message}`]; }
  const errors = [];
  if (receipt.policy_sha256 !== sha256_of_file(path.join(REPO_ROOT, "scripts/lib/pr-policy.mjs"))) errors.push("audit/pr-file-cap-reconstruction.json: pr-policy.mjs digest mismatch");
  const rows = receipt.rows || [], by_key = new Map();
  for (const row of rows) if (mapping(row)) by_key.set(JSON.stringify([get(row, 'repo'), get(row, 'pr')]), row);
  if (by_key.size !== rows.length) errors.push('audit/pr-file-cap-reconstruction.json: duplicate or invalid rows');
  const expected_keys = new Set();
  for (const ledger_path of ledgers()) {
    const data = load_yaml_file(ledger_path) || {};
    for (const candidate of data.prs || []) if (Number(candidate.files_reviewed_count || 0) > 3000) expected_keys.add(JSON.stringify([get(data, 'repo'), Number(candidate.number)]));
  }
  const missing = difference(expected_keys, new Set(by_key.keys())).map(JSON.parse).sort(tuple_compare);
  const unexpected = difference(new Set(by_key.keys()), expected_keys).map(JSON.parse).sort(tuple_compare);
  if (missing.length || unexpected.length) errors.push(`audit/pr-file-cap-reconstruction.json: capped candidate roster mismatch; missing=${tuple_list(missing)}, unexpected=${tuple_list(unexpected)}`);
  const current_pages = new Map();
  for (const page_path of pr_pages(path.join(SOURCES_DIR, 'prs'))) {
    const fm = extract_frontmatter(page_path);
    if (mapping(fm)) current_pages.set(JSON.stringify([get(fm, 'repo'), get(fm, 'pr')]), [fm, relpath(page_path)]);
  }
  for (const key of [...by_key.keys()].sort((a, b) => tuple_compare(JSON.parse(a), JSON.parse(b)))) {
    const row = by_key.get(key), key_repr = tuple(JSON.parse(key));
    errors.push(...cap_complete_file_evidence_errors(row, `cap receipt ${key_repr}`));
    const total = row.authoritative_changed_files;
    if (row.files_api_enumerated !== 3000 || !(Number.isInteger(total) || typeof total === 'boolean') || total <= 3000 || row.full_diff_paths !== total || row.full_diff_complete !== true || row.enumeration_complete !== false) errors.push(`audit/pr-file-cap-reconstruction.json: invalid count state for ${key_repr}`);
    const policy = row.full_policy || {};
    if (get(row, 'disposition') !== get(policy, 'disposition')) errors.push(`audit/pr-file-cap-reconstruction.json: policy outcome mismatch for ${key_repr}`);
    const current = current_pages.get(key);
    if (truth(policy.retain)) {
      if (!current) errors.push(`audit/pr-file-cap-reconstruction.json: retained page missing for ${key_repr}`);
      else errors.push(...cap_reconstruction_page_errors(current[0], row, current[1]));
    } else if (current) errors.push(`audit/pr-file-cap-reconstruction.json: removed page exists for ${key_repr}`);
  }
  return errors;
}

const FRONTMATTER = /^---\s*\r?\n(.*?)\r?\n---\s*\r?\n/s;
export function extract_frontmatter(filepath) {
  const match = FRONTMATTER.exec(text(filepath));
  if (!match) return null;
  try { return yaml(match[1]); } catch (error) { return { _parse_error: error.message }; }
}
export function read_body(filepath) {
  const content = text(filepath), match = FRONTMATTER.exec(content);
  return match ? content.slice(match[0].length) : content;
}
export function architecture_receipt_record(fm) {
  return [get(fm, 'upstream_body_sha256'), get(fm, 'upstream_files_sha256'), get(fm, 'architectures'), get(fm, 'architecture_disposition'), hash(canonical_json(get(fm, 'architecture_evidence')))];
}
export function compare_pr_architecture_receipt(actual_rows, receipt) {
  const errors = [];
  if (!mapping(receipt) || receipt.schema_version !== 1) return ['data/pr-architecture-evidence.json: missing or unsupported schema_version'];
  const expected_rows = receipt.rows;
  if (!mapping(expected_rows)) return ['data/pr-architecture-evidence.json: rows must be a mapping'];
  const expected_fields = ['upstream_body_sha256', 'upstream_files_sha256', 'architectures', 'architecture_disposition', 'architecture_evidence_sha256'];
  if (!isDeepStrictEqual(receipt.row_fields, expected_fields)) errors.push('data/pr-architecture-evidence.json: row_fields contract mismatch');
  if (receipt.policy_sha256 !== sha256_of_file(path.join(REPO_ROOT, "scripts/lib/pr-policy.mjs"))) errors.push("data/pr-architecture-evidence.json: pr-policy.mjs digest mismatch");
  const expected_keys = new Set(Object.keys(expected_rows)), actual_keys = new Set(Object.keys(actual_rows));
  const missing = sorted(difference(expected_keys, actual_keys)), unexpected = sorted(difference(actual_keys, expected_keys));
  if (missing.length) errors.push(`data/pr-architecture-evidence.json: ${missing.length} receipted page(s) missing; first 5: ${repr(missing.slice(0, 5))}`);
  if (unexpected.length) errors.push(`data/pr-architecture-evidence.json: ${unexpected.length} unreceipted page(s); first 5: ${repr(unexpected.slice(0, 5))}`);
  for (const filename of sorted(intersection(actual_keys, expected_keys))) {
    const expected = expected_rows[filename], actual = actual_rows[filename];
    if (!isDeepStrictEqual(actual, expected)) {
      const differing = expected_fields.filter((_, index) => index < actual.length && index < expected.length && !isDeepStrictEqual(actual[index], expected[index]));
      errors.push(`sources/prs/${filename}: architecture receipt mismatch in ${repr(differing)}`);
    }
  }
  return errors;
}
export function validate_pr_architecture_receipt() {
  if (!is_file(PR_ARCHITECTURE_RECEIPT)) return ['data/pr-architecture-evidence.json: required architecture receipt is missing'];
  let receipt;
  try { receipt = JSON.parse(text(PR_ARCHITECTURE_RECEIPT)); }
  catch (error) { return [`data/pr-architecture-evidence.json: cannot parse receipt: ${error.message}`]; }
  const actual_rows = {};
  for (const page_path of pr_pages(path.join(SOURCES_DIR, 'prs'))) {
    const fm = extract_frontmatter(page_path);
    if (mapping(fm)) actual_rows[path.relative(path.join(SOURCES_DIR, 'prs'), page_path).split(path.sep).join('/')] = architecture_receipt_record(fm);
  }
  return compare_pr_architecture_receipt(actual_rows, receipt);
}

export function detect_page_type(filepath, fm) {
  const parts = relpath(filepath).split('/');
  if (parts[0] === 'sources') return ({ prs: 'source-pr', docs: 'source-doc', blogs: 'source-blog', contests: 'source-contest' })[parts[1]] || 'unknown';
  if (parts[0] === 'wiki') {
    if (truth(fm.type)) return `wiki-${fm.type}`;
    return ({ hardware: 'wiki-hardware', techniques: 'wiki-technique', patterns: 'wiki-pattern', kernels: 'wiki-kernel', languages: 'wiki-language', migration: 'wiki-migration' })[parts[1]] || 'unknown';
  }
  return 'unknown';
}
export function arxiv_source_classification_errors(filepath, fm, page_type) {
  if (!/^https?:\/\/(?:www\.)?arxiv\.org\//i.test(str(fm.url || ''))) return [];
  if (page_type === 'source-doc' && fm.source_category === 'paper') return [];
  const relative = relpath(filepath);
  const rel = relative === '..' || relative.startsWith('../') ? filepath : relative;
  return [`${rel}: arXiv source must use source-doc with source_category: paper (got ${page_type}, ${repr(get(fm, 'source_category'))})`];
}
export function merge_sha_contract_errors(fm, rel = 'source-pr') {
  if (fm.status === 'merged' && !/^[0-9a-fA-F]{40}$/.test(str(fm.merge_sha || ''))) return [`${rel}: merged PR requires a full 40-hex merge_sha`];
  if (fm.status !== 'merged' && Object.hasOwn(fm, 'merge_sha')) return [`${rel}: merge_sha must be omitted unless status is 'merged'`];
  return [];
}
export function ptx_isa_curated_anchor_errors(body, rel = 'curated page') {
  const fragments = new Set([...body.matchAll(/https:\/\/docs\.nvidia\.com\/cuda\/parallel-thread-execution\/(?:index\.html)?#([A-Za-z0-9._-]+)/g)].map(match => match[1]));
  return sorted(difference(fragments, PTX_ISA_CURATED_ANCHORS)).map(fragment => `${rel}: unverified PTX ISA fragment '#${fragment}'`);
}
export function blackwell_relevance_errors(fm, page_type, rel = 'wiki page') {
  if (!page_type.startsWith('wiki-')) return [];
  const architectures = new Set(Array.isArray(fm.architectures) ? fm.architectures : []);
  const hopper = intersection(architectures, HOPPER_ARCHITECTURES), blackwell = intersection(architectures, BLACKWELL_ARCHITECTURES);
  if (hopper.length && !blackwell.length && !Object.hasOwn(fm, 'blackwell_relevance')) return [`${rel}: page targets only Hopper ${repr(new Set(hopper))} without Blackwell arch; add 'blackwell_relevance' to justify inclusion in Blackwell-first scope`];
  return [];
}
export function repro_at_least(level, minimum) {
  return REPRO_ORDER.includes(level) && REPRO_ORDER.includes(minimum) && REPRO_ORDER.indexOf(level) >= REPRO_ORDER.indexOf(minimum);
}
export const _BASE_CODE_LANGS = new Set(['cuda', 'c', 'c++', 'cpp', 'python', 'py', 'ptx', 'asm', 'cuda-cpp', 'cu', 'rust', 'shell', 'bash', 'yaml', 'json']);
export function _load_code_langs() {
  const languages = new Set(_BASE_CODE_LANGS), filename = path.join(DATA_DIR, 'tags.yaml');
  if (existsSync(filename)) for (const language of load_yaml_file(filename).languages || []) languages.add(language);
  return languages;
}
export const _CODE_INDICATORS = /__global__|__device__|__shared__|__host__|asm\s+volatile|#include|#define|#pragma|\bvoid\b|\bint\b|\buint32_t\b|\buint64_t\b|\bfloat\b|\bhalf\b|\bstruct\b|\btypedef\b|\btemplate\b|\bnamespace\b|\busing\b|\bauto\b|\bconstexpr\b|\bfor\s*\(|\bwhile\s*\(|\bif\s*\(|return\s|(?:\w+::)+\w+|\w+(?:\.|->)\w+\s*\(|\bdef\s+\w+|\bif\s+[^\n:]+:|\bfor\s+\w+\s+in\s+|\breturn\b|import\s+\w+|@triton\.jit|tl\.\w+|\w+\s*=\s*\w+\s*\(|\bnvcc\s|\bcmake\s|\bpython3?\s|tcgen05|mbarrier|cp\.async|ld\.global|st\.global|\.reg\s|\.pred\s|cvt\.\w+|mov\.b32|@T\.prim_func|T\.alloc_buffer|T\.grid|T\.block_attr|T\.reads|T\.writes|cutile\.\w+|@cutile\.kernel|tile_load|tile_store|tile_mma|pl\.\w+|@pl\.kernel|pallas\.|jax\.\w+|jnp\.\w+/;
export function has_compilable_code(body, code_langs) {
  for (const match of body.matchAll(/^```(\S*)\s*\n(.*?)\n```/gms)) {
    if (!code_langs.has(match[1].toLowerCase()) || !_CODE_INDICATORS.test(match[2])) continue;
    const lines = match[2].split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//') && !line.startsWith('#'));
    if (lines.length >= 2) return true;
  }
  return false;
}

export function validate_file(filepath, schemas, valid_tags, all_source_ids, code_langs) {
  const errors = [], rel = relpath(filepath), fm = extract_frontmatter(filepath);
  if (fm == null) return [`${rel}: missing YAML frontmatter`];
  if (!mapping(fm)) return [`${rel}: frontmatter must be a YAML mapping, got ${typename(fm)}`];
  if ('_parse_error' in fm) return [`${rel}: YAML parse error: ${fm._parse_error}`];
  const page_type = detect_page_type(filepath, fm);
  if (page_type === 'unknown') return [`${rel}: unknown page type`];
  errors.push(...arxiv_source_classification_errors(filepath, fm, page_type));
  if (page_type === 'source-pr') errors.push(...merge_sha_contract_errors(fm, rel));
  if (page_type.startsWith('wiki-') || page_type === 'source-doc') errors.push(...ptx_isa_curated_anchor_errors(read_body(filepath), rel));
  const schema = schemas[page_type];
  if (!truth(schema)) return [...errors, `${rel}: no schema defined for type '${page_type}'`];
  const constraints = schema.constraints || {};
  for (const field of schema.required || []) if (fm[field] == null) errors.push(`${rel}: missing required field '${field}'`);
  if (constraints.id_prefix && 'id' in fm && !str(fm.id).startsWith(constraints.id_prefix)) errors.push(`${rel}: id '${str(fm.id)}' must start with '${constraints.id_prefix}'`);
  const topical = ['hardware_features', 'techniques', 'kernel_types', 'languages'];
  const field_vocab = { tags: new Set(topical.flatMap(cat => valid_tags[cat] || [])) };
  for (const field of topical) field_vocab[field] = new Set(valid_tags[field] || []);
  for (const field of ['tags', ...topical, 'architectures', 'related', 'sources', 'symptoms', 'candidate_techniques', 'prerequisites', 'aliases']) {
    if (!(field in fm)) continue;
    if (!Array.isArray(fm[field])) { errors.push(`${rel}: field '${field}' must be a YAML list, got ${typename(fm[field])}`); continue; }
    const seen = new Set();
    for (const value of fm[field]) { if (seen.has(value)) errors.push(`${rel}: duplicate value '${str(value)}' in field '${field}'`); seen.add(value); }
  }
  if (Array.isArray(fm.hardware_features)) {
    const missing = difference(new Set(intersection(new Set(fm.tags || []), field_vocab.hardware_features)), new Set(fm.hardware_features));
    if (missing.length) errors.push(`${rel}: tags contain hardware features ${repr(sorted(missing))} not in hardware_features field`);
  }
  for (const [field, vocab] of Object.entries(field_vocab)) if (Array.isArray(fm[field])) for (const tag of fm[field]) if (!vocab.has(tag)) errors.push(`${rel}: '${str(tag)}' is not a valid ${field} value`);
  const remedy_prefixes = ['technique-', 'hw-', 'migration-'];
  if (Array.isArray(fm.candidate_techniques)) for (const ct of fm.candidate_techniques) if (!remedy_prefixes.some(prefix => str(ct).startsWith(prefix))) errors.push(`${rel}: candidate_techniques entry '${str(ct)}' must use one of ${tuple(remedy_prefixes)} prefixes`);
  const valid_archs = new Set(valid_tags.architectures || []);
  if (Array.isArray(fm.architectures)) for (const arch of fm.architectures) if (!valid_archs.has(arch)) errors.push(`${rel}: unknown architecture '${str(arch)}'`);
  if (page_type === 'source-pr') {
    errors.push(...changed_file_inventory_errors(fm, rel));
    const archs = fm.architectures, disposition = fm.architecture_disposition;
    let evidence = fm.architecture_evidence;
    if (!['exact', 'family', 'mixed', 'unknown'].includes(disposition)) errors.push(`${rel}: architecture_disposition must be exact, family, mixed, or unknown`);
    if (!Array.isArray(evidence) || !evidence.length) { errors.push(`${rel}: architecture_evidence must be a non-empty list`); evidence = []; }
    const evidence_values = new Set();
    for (const [index, row] of evidence.entries()) {
      if (!mapping(row)) { errors.push(`${rel}: architecture_evidence[${index}] must be a mapping`); continue; }
      for (const field of ['architecture', 'basis', 'locator', 'evidence']) if (typeof row[field] !== 'string' || !row[field].trim()) errors.push(`${rel}: architecture_evidence[${index}].${field} must be a non-empty string`);
      if (truth(row.architecture)) evidence_values.add(row.architecture);
      if (row.basis === 'documented-product-mapping' && (typeof row.mapping_source !== 'string' || !row.mapping_source.startsWith('https://'))) errors.push(`${rel}: documented product mapping requires an HTTPS mapping_source`);
    }
    if (Array.isArray(archs)) {
      const families = new Set(Object.keys(ARCHITECTURE_FAMILY_PREFIXES)), values = new Set(archs), unsupported = sorted(difference(values, evidence_values));
      if (disposition === 'unknown') {
        if (archs.length) errors.push(`${rel}: unknown disposition requires architectures: []`);
        if (!evidence_values.has('unknown')) errors.push(`${rel}: unknown disposition requires an unknown evidence note`);
      } else if (disposition === 'family') {
        if (!archs.length || difference(values, families).length) errors.push(`${rel}: family disposition requires only recognized family values`);
        if (unsupported.length) errors.push(`${rel}: family assignments lack matching evidence: ${repr(unsupported)}`);
      } else if (disposition === 'exact') {
        if (!archs.length || intersection(values, families).length) errors.push(`${rel}: exact disposition requires one or more exact values and no family placeholder`);
        if (unsupported.length) errors.push(`${rel}: architecture assignments lack matching evidence: ${repr(unsupported)}`);
      } else if (disposition === 'mixed') {
        if (!intersection(values, families).length || !difference(values, families).length) errors.push(`${rel}: mixed disposition requires family and exact values`);
        if (unsupported.length) errors.push(`${rel}: mixed architecture assignments lack matching evidence: ${repr(unsupported)}`);
      }
    }
    if (fm.scope_disposition !== 'retained') errors.push(`${rel}: source PR pages must have scope_disposition: retained`);
    const scope = fm.scope_evidence;
    if (!mapping(scope)) errors.push(`${rel}: scope_evidence must be a mapping`);
    else {
      const rule = get(scope, 'rule'), paths = scope.paths;
      if (!['cuda-cute-ptx-device-source', 'python-dsl-device-kernel', 'device-code-signal'].includes(rule)) errors.push(`${rel}: unsupported retained scope rule ${repr(rule)}`);
      if (!Array.isArray(paths) || !paths.length) errors.push(`${rel}: retained scope_evidence.paths must be a non-empty list`);
      else {
        const absent = sorted(difference(new Set(paths), new Set(fm.changed_paths || [])));
        if (absent.length) errors.push(`${rel}: scope evidence paths absent from changed_paths: ${repr(absent)}`);
        if (rule === 'cuda-cute-ptx-device-source' && paths.some(p => !['.cu', '.cuh', '.ptx'].includes(path.extname(p).toLowerCase()))) errors.push(`${rel}: CUDA/CuTe/PTX scope rule cites a non-device-source path`);
        if (rule === 'python-dsl-device-kernel' && paths.some(p => path.extname(p).toLowerCase() !== '.py')) errors.push(`${rel}: Python DSL scope rule cites a non-Python path`);
      }
    }
    if (typeof fm.inclusion_reason !== 'string' || !fm.inclusion_reason.startsWith('retain:')) errors.push(`${rel}: inclusion_reason must name the concrete retained rule/evidence`);
    if (/(?<![a-z0-9])(eplb|deep[ _-]?ep|dual[ _-]?pipe)(?![a-z0-9])/i.test(str(get(fm, 'title', '')))) errors.push(`${rel}: hard-excluded EPLB/DeepEP/DualPipe source page is present`);
    if (typeof fm.upstream_body_locator !== 'string' || !fm.upstream_body_locator.startsWith('https://')) errors.push(`${rel}: upstream_body_locator must be a non-empty HTTPS locator`);
    for (const problem of body_contract_errors(fm, read_body(filepath))) errors.push(`${rel}: ${problem}`);
  }
  for (const field of ['from_arch', 'to_arch']) if (field in fm && !valid_archs.has(fm[field])) errors.push(`${rel}: ${field} '${str(fm[field])}' is not a known architecture`);
  for (const field of ['confidence', 'reproducibility']) if (field in fm && !(valid_tags[field] || []).includes(fm[field])) errors.push(`${rel}: invalid ${field} '${str(fm[field])}'`);
  if (constraints.reproducibility_minimum && 'reproducibility' in fm && !repro_at_least(fm.reproducibility, constraints.reproducibility_minimum)) errors.push(`${rel}: reproducibility '${str(fm.reproducibility)}' below minimum '${constraints.reproducibility_minimum}' for ${page_type}`);
  if ('source_category' in fm) {
    const cat = fm.source_category;
    if (!(valid_tags.source_categories || []).includes(cat)) errors.push(`${rel}: invalid source_category '${str(cat)}'`);
    if (truth(constraints.source_category)) {
      const allowed = Array.isArray(constraints.source_category) ? constraints.source_category : [constraints.source_category];
      if (!allowed.includes(cat)) errors.push(`${rel}: source_category '${str(cat)}' not in allowed ${repr(allowed)}`);
    }
  }
  if (truth(constraints.status) && 'status' in fm) {
    const allowed = Array.isArray(constraints.status) ? constraints.status : [constraints.status];
    if (!allowed.includes(fm.status)) errors.push(`${rel}: status '${str(fm.status)}' not in ${repr(allowed)}`);
  }
  if ('type' in constraints && 'type' in fm && fm.type !== constraints.type) errors.push(`${rel}: type '${str(fm.type)}' does not match expected '${str(constraints.type)}' for ${page_type}`);
  errors.push(...blackwell_relevance_errors(fm, page_type, rel));
  if ('performance_claims' in fm) {
    if (!Array.isArray(fm.performance_claims)) errors.push(`${rel}: performance_claims must be a list, got ${typename(fm.performance_claims)}`);
    else for (const [i, claim] of fm.performance_claims.entries()) {
      if (!mapping(claim)) { errors.push(`${rel}: performance_claims[${i}] must be a mapping, got ${typename(claim)}`); continue; }
      for (const req of ['gpu', 'dtype', 'shape', 'metric', 'value', 'source_id', 'source_locator']) if (!(req in claim)) errors.push(`${rel}: performance_claims[${i}] missing '${req}'`);
      if ('value' in claim && !['number', 'boolean'].includes(typeof claim.value)) errors.push(`${rel}: performance_claims[${i}].value must be numeric, got ${typename(claim.value)}: ${str(claim.value)}`);
      if (truth(claim.source_id) && truth(all_source_ids) && !all_source_ids.has(claim.source_id)) errors.push(`${rel}: performance_claims[${i}].source_id '${str(claim.source_id)}' not found in source corpus`);
      if ('source_locator' in claim && (typeof claim.source_locator !== 'string' || !claim.source_locator.trim())) errors.push(`${rel}: performance_claims[${i}].source_locator must be a non-empty exact locator`);
    }
  }
  if (page_type.startsWith('wiki-') && Array.isArray(fm.sources)) for (const sid of fm.sources) if (truth(all_source_ids) && !all_source_ids.has(sid)) errors.push(`${rel}: references unknown source id '${str(sid)}'`);
  if (page_type.startsWith('wiki-') && fm.confidence === 'verified') {
    const eb = fm.evidence_basis;
    if (!Array.isArray(eb) || !eb.length) errors.push(`${rel}: confidence 'verified' requires non-empty 'evidence_basis' field`);
    else {
      const types = new Set(eb.filter(mapping).map(entry => get(entry, 'evidence_type')));
      for (const type of ['official-doc', 'upstream-code']) if (!types.has(type)) errors.push(`${rel}: evidence_basis for 'verified' must include at least one '${type}' entry (found: ${repr(types)})`);
      const page_sources = new Set(fm.sources || []);
      for (const entry of eb) if (mapping(entry) && truth(entry.source_id) && !page_sources.has(entry.source_id)) errors.push(`${rel}: evidence_basis references '${str(entry.source_id)}' not listed in page sources`);
    }
  }
  if (['wiki-technique', 'wiki-kernel', 'wiki-language'].includes(page_type) && repro_at_least(get(fm, 'reproducibility', 'concept'), 'snippet') && !has_compilable_code(read_body(filepath), code_langs)) errors.push(`${rel}: ${page_type} page must contain fenced code block (reproducibility >= snippet)`);
  for (const banned of schema.disallow_peer_of_artifact_dir || []) if (banned in fm) errors.push(`${rel}: page frontmatter must not carry '${banned}:' at top level (single-field contract: use 'artifact_dir:' only; per-file pointers live inside PROVENANCE.yaml)`);
  if ('artifact_dir' in fm) {
    const ad = fm.artifact_dir;
    if (typeof ad !== 'string') errors.push(`${rel}: artifact_dir must be a string path`);
    else {
      const target = path.resolve(REPO_ROOT, ad);
      if (!is_dir(target)) errors.push(`${rel}: artifact_dir '${ad}' does not resolve to an existing directory`);
      else try {
        const actual = resolved(target), root = resolved(ARTIFACTS_DIR);
        if (!contains(root, actual)) errors.push(`${rel}: artifact_dir '${ad}' must live under 'artifacts/' (code assets are quarantined from wiki/ per AC-9); resolves to '${actual}' which is outside '${root}'`);
      } catch (error) { errors.push(`${rel}: artifact_dir '${ad}' could not be resolved: ${error.message}`); }
    }
  }
  if (page_type === 'source-contest' && 'submissions' in fm) errors.push(...validate_contest_submissions(fm, filepath, schemas));
  return errors;
}

export function validate_contest_submissions(fm, filepath, schemas) {
  const rel = relpath(filepath), errors = [], subs = fm.submissions || [];
  const schema = schemas['source-contest']?.submissions_schema || {};
  const required = schema.required || [], optional = schema.optional || [], allowed = schema.constraints?.submission_truth || [];
  const prefix = `artifacts/contests/${path.basename(path.dirname(filepath))}/${path.basename(filepath, path.extname(filepath))}/submissions/`;
  let root;
  try { root = resolved(path.join(REPO_ROOT, prefix)); } catch { root = path.join(REPO_ROOT, prefix); }
  for (const [i, entry] of subs.entries()) {
    if (!mapping(entry)) { errors.push(`${rel}: submissions[${i}] must be a mapping, got ${typename(entry)}`); continue; }
    for (const req of required) if (!(req in entry)) errors.push(`${rel}: submissions[${i}] missing required '${req}'`);
    const value = entry.submission_truth;
    if (value != null && allowed.length && !allowed.includes(value)) errors.push(`${rel}: submissions[${i}].submission_truth '${str(value)}' not in ${repr(allowed)}`);
    if (value === 'unavailable') {
      if (!truth(entry.code_unavailable_reason)) errors.push(`${rel}: submissions[${i}] has submission_truth='unavailable' but no 'code_unavailable_reason'`);
    } else if (value != null) {
      const cp = entry.code_path;
      if (!truth(cp)) errors.push(`${rel}: submissions[${i}] has submission_truth='${str(value)}' but no 'code_path'`);
      else {
        const target = path.resolve(REPO_ROOT, cp);
        if (!existsSync(target)) errors.push(`${rel}: submissions[${i}].code_path '${cp}' does not exist`);
        else try {
          const actual = resolved(target);
          if (!contains(root, actual)) errors.push(`${rel}: submissions[${i}].code_path '${cp}' must live under '${prefix}' (the page's own implicit submission bundle), not an arbitrary location inside artifacts/contests/; resolves to '${actual}' which is outside '${root}'`);
        } catch (error) { errors.push(`${rel}: submissions[${i}].code_path '${cp}' could not be resolved: ${error.message}`); }
      }
    }
    for (const key of Object.keys(entry)) if (![...required, ...optional].includes(key)) errors.push(`${rel}: submissions[${i}] has unknown field '${key}'`);
  }
  return errors;
}
export const LEDGER_REQUIRED_TOP_FIELDS = ['repo', 'searched_at', 'keywords_used', 'total_candidates', 'included', 'excluded', 'deferred', 'prs'];
export const LEDGER_REQUIRED_PR_FIELDS = ['number', 'title', 'date', 'decision', 'reason'];
export function validate_ledger(ledger_path) {
  const errors = [], rel = relpath(ledger_path);
  let data;
  try { data = load_yaml_file(ledger_path); } catch (error) { if (error.code) throw error; return [`${rel}: invalid YAML (${error.message})`]; }
  if (!mapping(data)) return [`${rel}: top-level value must be a mapping`];
  for (const field of LEDGER_REQUIRED_TOP_FIELDS) if (!(field in data)) errors.push(`${rel}: missing required top-level field '${field}'`);
  if (errors.length) return errors;
  if (!Array.isArray(data.prs)) return [`${rel}: 'prs' must be a list, got ${typename(data.prs)}`];
  const counts = { include: 0, exclude: 0, defer: 0 };
  for (const [i, row] of data.prs.entries()) {
    if (!mapping(row)) { errors.push(`${rel}: prs[${i}] must be a mapping`); continue; }
    for (const field of LEDGER_REQUIRED_PR_FIELDS) if (!(field in row)) errors.push(`${rel}: prs[${i}] missing required field '${field}'`);
    const decision = str(get(row, 'decision', '')).toLowerCase();
    if (Object.hasOwn(counts, decision)) counts[decision]++;
    else errors.push(`${rel}: prs[${i}] has unknown decision '${str(get(row, 'decision'))}'`);
  }
  if (data.total_candidates !== data.prs.length) errors.push(`${rel}: total_candidates=${str(data.total_candidates)} disagrees with len(prs)=${data.prs.length}`);
  for (const [field, decision] of [['included', 'include'], ['excluded', 'exclude'], ['deferred', 'defer']]) if (data[field] !== counts[decision]) errors.push(`${rel}: ${field}=${str(data[field])} disagrees with row count ${counts[decision]}`);
  if (data.total_candidates !== data.included + data.excluded + data.deferred) errors.push(`${rel}: total_candidates (${str(data.total_candidates)}) != included + excluded + deferred (${str(data.included)} + ${str(data.excluded)} + ${str(data.deferred)})`);
  return errors;
}
const scope_pages = () => [...markdown(WIKI_DIR), ...['primer.md', 'examples.md'].map(name => path.join(REPO_ROOT, 'references', name)).filter(is_file)];
export function validate_version_claims_registry(all_source_ids) {
  const errors = [], filename = path.join(DATA_DIR, 'version-claims.yaml');
  if (!is_file(filename)) return ['data/version-claims.yaml: missing (DEC-1 hybrid registry stub required)'];
  let data;
  try { data = load_yaml_file(filename); } catch (error) { if (error.code) throw error; return [`data/version-claims.yaml: invalid YAML (${error.message})`]; }
  const by_id = new Map();
  for (const [i, claim] of (data?.claims || []).entries()) {
    if (!mapping(claim)) { errors.push(`data/version-claims.yaml::claims[${i}]: must be a mapping`); continue; }
    const cid = claim.id;
    if (!truth(cid)) { errors.push(`data/version-claims.yaml::claims[${i}]: missing id`); continue; }
    by_id.set(cid, claim);
    for (const sid of claim.source_ids || []) if (!all_source_ids.has(sid)) errors.push(`data/version-claims.yaml::${cid}: source_id '${sid}' does not resolve`);
    for (const applies of claim.applies_to || []) {
      const split = applies.indexOf('::'), file = split < 0 ? applies : applies.slice(0, split), scalar = split < 0 ? '' : applies.slice(split + 2);
      const target = path.resolve(REPO_ROOT, file);
      if (!existsSync(target)) { errors.push(`data/version-claims.yaml::${cid}: applies_to '${applies}' (file '${file}') does not exist`); continue; }
      if (scalar) continue;
      let fm;
      try { fm = extract_frontmatter(target); } catch (error) { errors.push(`data/version-claims.yaml::${cid}: applies_to '${applies}' frontmatter parse failed: ${error.message}`); continue; }
      if (!truth(fm) || !mapping(fm)) { errors.push(`data/version-claims.yaml::${cid}: applies_to '${applies}' has no frontmatter (AC-2 reverse direction: target must carry version_sensitive: ${cid})`); continue; }
      const vs = get(fm, 'version_sensitive'), ptr = mapping(vs) ? get(vs, 'id') : vs;
      if (ptr !== cid) errors.push(`data/version-claims.yaml::${cid}: applies_to '${applies}' carries version_sensitive id=${repr(ptr)}, expected ${repr(cid)} (AC-2 reverse direction)`);
    }
  }
  for (const page of scope_pages()) {
    const fm = extract_frontmatter(page);
    if (!truth(fm) || !mapping(fm) || fm.version_sensitive == null) continue;
    const vs = fm.version_sensitive, ptr = mapping(vs) ? get(vs, 'id') : vs;
    if (!truth(ptr)) errors.push(`${relpath(page)}: version_sensitive block has no id`);
    else if (!by_id.has(ptr)) errors.push(`${relpath(page)}: version_sensitive id '${str(ptr)}' does not resolve to data/version-claims.yaml`);
  }
  return errors;
}

export function validate_inclusion_policy_scalars() {
  const filename = path.join(DATA_DIR, 'inclusion-policy.yaml'), errors = [];
  if (!is_file(filename)) return errors;
  const raw = text(filename);
  let data;
  try { data = yaml(raw); } catch (error) { return [`data/inclusion-policy.yaml: invalid YAML (${error.message})`]; }
  if ((data?.triton?.description || '').toLowerCase().includes('no direct tcgen05/tmem access')) errors.push("data/inclusion-policy.yaml::triton.description: still contains obsolete substring 'no direct tcgen05/TMEM access' (AC-11)");
  if (raw.toLowerCase().includes('no direct tcgen05/tmem access')) errors.push("data/inclusion-policy.yaml: raw text (including comments) still contains obsolete substring 'no direct tcgen05/TMEM access' (AC-11)");
  return errors;
}
const plans = () => children(REPO_ROOT).filter(filename => /^plan-phase.*\.md$/.test(path.basename(filename)));
export function validate_plan_supersession() {
  const errors = [];
  for (const filename of plans()) {
    const name = path.basename(filename), has = text(filename).split('\n').slice(0, 3).some(line => /^>\s*Superseded by/i.test(line));
    if (name === 'plan-phase4.md') { if (has) errors.push(`${name}: current-round plan must not carry a supersession header`); }
    else if (!has) errors.push(`${name}: missing supersession header in first 3 lines (AC-9, DEC-7 per-file mode)`);
  }
  if (existsSync(path.join(REPO_ROOT, 'references/supersession.md'))) errors.push('references/supersession.md: must not exist (DEC-7 chose per-file header mechanism, not the index)');
  return errors;
}
export function validate_skip_audit_coverage() {
  const errors = [], filename = path.join(DATA_DIR, 'pr-page-skipped.yaml');
  let rows = [];
  if (is_file(filename)) try { rows = load_yaml_file(filename)?.rows || []; } catch (error) { if (error.code) throw error; return [`data/pr-page-skipped.yaml: invalid YAML (${error.message})`]; }
  const keys = new Set(rows.filter(row => mapping(row) && 'repo' in row && 'pr_number' in row).map(row => JSON.stringify([row.repo, row.pr_number])));
  for (const filename of ledgers()) {
    const ledger = load_yaml_file(filename) || {}, repo = ledger.repo;
    if (!truth(repo)) continue;
    const slug = repo.includes('/') ? repo.split('/')[1] : path.basename(filename, '.yaml');
    const pages = new Set(children(path.join(SOURCES_DIR, 'prs', slug)).filter(p => /^PR-.*\.md$/.test(path.basename(p))).map(p => path.basename(p, '.md').split('-')[1]).filter(n => /^[+-]?\d+$/.test(n)).map(Number));
    for (const row of ledger.prs || []) {
      if (!mapping(row) || str(get(row, 'decision', '')).toLowerCase() !== 'include') continue;
      const num = get(row, 'number');
      if (pages.has(num) || keys.has(JSON.stringify([repo, num]))) continue;
      errors.push(`AC-4 coverage: ${repo} PR #${str(num)} is \`decision: include\` but has neither sources/prs/${slug}/PR-${str(num)}.md nor a data/pr-page-skipped.yaml row`);
    }
  }
  return errors;
}
export function validate_refresh_cutoff_alignment() {
  const filename = path.join(DATA_DIR, 'refresh-cutoff.yaml'), errors = [];
  if (!is_file(filename)) return errors;
  let data;
  try { data = load_yaml_file(filename) || {}; } catch (error) { if (error.code) throw error; return [`data/refresh-cutoff.yaml: invalid YAML (${error.message})`]; }
  if (data.cutoff_date == null) return ['data/refresh-cutoff.yaml: missing cutoff_date'];
  const cutoff = str(data.cutoff_date);
  for (const ledger_file of ledgers()) {
    const searched = str(get(load_yaml_file(ledger_file) || {}, 'searched_at'));
    if (searched !== cutoff) errors.push(`AC-5: ${relpath(ledger_file)}::searched_at (${repr(searched)}) != data/refresh-cutoff.yaml::cutoff_date (${repr(cutoff)})`);
  }
  return errors;
}
export function validate_refresh_subset() {
  const filename = path.join(DATA_DIR, 'refresh-search-results.yaml'), errors = [];
  if (!is_file(filename)) return errors;
  let results;
  try { results = load_yaml_file(filename) || {}; } catch (error) { if (error.code) throw error; return [`data/refresh-search-results.yaml: invalid YAML (${error.message})`]; }
  for (const block of results.repos || []) {
    const slug = block.repo_slug;
    if (!truth(slug)) continue;
    const ledger_path = path.join(CANDIDATES_DIR, `${slug}.yaml`);
    if (!is_file(ledger_path)) continue;
    const nums = new Set((load_yaml_file(ledger_path)?.prs || []).filter(mapping).map(row => get(row, 'number')));
    const missing = difference(new Set(block.pr_numbers_seen || []), nums);
    if (missing.length) errors.push(`AC-5 subset: ${missing.length} pr_numbers_seen for ${slug} are NOT in candidates/${slug}.yaml::prs[*].number (first 5: ${repr(sorted(missing).slice(0, 5))})`);
  }
  return errors;
}
export function _load_previous_pages_manifest() {
  const filename = path.join(DATA_DIR, 'refresh-cutoff.yaml');
  if (!is_file(filename)) return null;
  let data;
  try { data = load_yaml_file(filename) || {}; } catch (error) { if (error.code) throw error; return null; }
  return Array.isArray(data.previous_pages_manifest) ? new Set(data.previous_pages_manifest) : null;
}
export function validate_captured_at_cutoff() {
  const filename = path.join(DATA_DIR, 'refresh-cutoff.yaml'), errors = [];
  if (!is_file(filename) || !existsSync(SOURCES_DIR)) return errors;
  let cutoff;
  try { cutoff = load_yaml_file(filename)?.cutoff_date; } catch (error) { if (error.code) throw error; return errors; }
  if (cutoff == null) return errors;
  const previous = _load_previous_pages_manifest();
  for (const dir of children(path.join(SOURCES_DIR, 'prs')).filter(is_dir)) for (const page of children(dir).filter(p => /^PR-.*\.md$/.test(path.basename(p)))) {
    const fm = extract_frontmatter(page);
    if (!truth(fm) || !mapping(fm) || fm.captured_at == null) continue;
    const rel = relpath(page), captured = str(fm.captured_at);
    if (previous !== null && !previous.has(rel) && captured < str(cutoff)) errors.push(`${rel}: page is new this round but captured_at=${repr(captured)} precedes cutoff_date ${repr(str(cutoff))} (AC-4: freshly-generated pages must use current evidence)`);
  }
  return errors;
}
export const CLAIM_SIGNATURE_PATTERNS = [String.raw`\bno direct tcgen05 access\b`, String.raw`\bno TMEM:\s*accumulators stay in registers\b`, String.raw`\btriton compiler generates wgmma\b`];
export function validate_claim_bearing_pages_have_pointer() {
  const errors = [], signature = new RegExp(CLAIM_SIGNATURE_PATTERNS.join('|'), 'i');
  for (const filename of scope_pages()) {
    const raw = text(filename);
    if (!signature.test(raw)) continue;
    const stripped = raw.replace(/##\s*Pre-3\.6 historical context.*?(?=\n##\s|(?![\s\S]))/gis, '');
    if (!signature.test(stripped)) continue;
    const fm = extract_frontmatter(filename);
    if (!truth(fm) || !mapping(fm)) errors.push(`${relpath(filename)}: contains claim signature outside historical-context block but has no frontmatter (AC-2 missing-pointer)`);
    else if (fm.version_sensitive == null) errors.push(`${relpath(filename)}: contains claim signature outside historical-context block but lacks version_sensitive frontmatter pointer (AC-2 missing-pointer)`);
  }
  return errors;
}

export function validate_cutlass_dev_pinning() {
  const errors = [], claims = new Map(), filename = path.join(DATA_DIR, 'version-claims.yaml');
  if (!existsSync(WIKI_DIR)) return errors;
  if (is_file(filename)) try {
    for (const claim of load_yaml_file(filename)?.claims || []) if (mapping(claim) && 'id' in claim) claims.set(claim.id, claim);
  } catch (error) { if (error.code) throw error; }
  for (const page of markdown(WIKI_DIR)) {
    if (!text(page).replace(/```.*?```/gs, '').includes('4.5-dev')) continue;
    const fm = extract_frontmatter(page), rel = relpath(page);
    if (!truth(fm) || !mapping(fm)) { errors.push(`${rel}: mentions '4.5-dev' outside code fences but has no frontmatter (DEC-4: dev-branch references require version_sensitive pointer)`); continue; }
    const confidence = get(fm, 'confidence');
    if (confidence === 'verified') { errors.push(`${rel}: mentions '4.5-dev' outside code fences with confidence: verified (DEC-4: verified pages cite stable releases only)`); continue; }
    if (!['source-reported', 'experimental'].includes(confidence)) { errors.push(`${rel}: mentions '4.5-dev' but confidence=${repr(confidence)} (DEC-4: must be source-reported or experimental)`); continue; }
    const vs = get(fm, 'version_sensitive'), ptr = mapping(vs) ? get(vs, 'id') : vs;
    if (!truth(ptr) || !claims.has(ptr)) { errors.push(`${rel}: mentions '4.5-dev' but version_sensitive pointer is absent or unresolved (DEC-4: requires registry entry with dev_branch_sha)`); continue; }
    const sha = claims.get(ptr).dev_branch_sha;
    if (!truth(sha) || ['none', 'null', 'needs-verification', ''].includes(str(sha).toLowerCase())) errors.push(`${rel}: mentions '4.5-dev' and version_sensitive resolves to ${repr(ptr)}, but the registry entry has no concrete dev_branch_sha (DEC-4)`);
  }
  return errors;
}
export function validate_plan_body_unchanged() {
  const errors = [], directory = path.join(DATA_DIR, 'plan-supersession-baselines');
  if (!is_dir(directory)) return errors;
  for (const plan of plans()) {
    if (path.basename(plan) === 'plan-phase4.md') continue;
    const baseline = path.join(directory, `${path.basename(plan, '.md')}.body.md`);
    if (!is_file(baseline)) continue;
    if (text(plan).replace(/^>\s*Superseded by[^\n]*\n(?:\n)?/m, '') !== text(baseline)) errors.push(`${path.basename(plan)}: body content (excluding supersession header block) differs from data/plan-supersession-baselines/${path.basename(baseline)} (AC-9 body-immutability vs pre-refresh git revision)`);
  }
  return errors;
}
export function validate_discoverability() {
  const errors = [];
  for (const page of markdown(path.join(SOURCES_DIR, 'upstreams'))) errors.push(`${relpath(page)}: sources/upstreams/ paths are forbidden (DEC-2 case-study mode reuses source-blog)`);
  const primer = path.join(REPO_ROOT, 'references/primer.md');
  if (!is_file(primer)) return errors;
  const section = /^## Source Repositories \(PR coverage\)\s*$\n(.*?)(?=^##\s|(?![\s\S]))/ms.exec(text(primer))?.[1] || '';
  const rows = new Map([...section.matchAll(/^\|\s*([^|\n]+\/[^|\n]+?)\s*\|\s*(\d+)\s*\|/gm)].map(match => [match[1].trim(), Number(match[2])]));
  const repos = new Map();
  for (const dir of children(path.join(SOURCES_DIR, 'prs')).filter(is_dir)) {
    const pages = children(dir).filter(p => /^PR-.*\.md$/.test(path.basename(p)));
    const identities = new Set(pages.map(extract_frontmatter).filter(fm => mapping(fm) && truth(fm.repo)).map(fm => str(fm.repo)));
    if (identities.size !== 1) { errors.push(`${relpath(dir)}: expected one repo identity across PR pages, found ${repr(sorted(identities))}`); continue; }
    repos.set([...identities][0], pages.length);
  }
  for (const repo of sorted(difference(new Set(repos.keys()), new Set(rows.keys())))) errors.push(`references/primer.md: repo table is missing row for ${repr(repo)} (AC-10)`);
  for (const repo of sorted(difference(new Set(rows.keys()), new Set(repos.keys())))) errors.push(`references/primer.md: repo table has stale row for ${repr(repo)} (AC-10)`);
  for (const repo of sorted(intersection(new Set(repos.keys()), new Set(rows.keys())))) if (rows.get(repo) !== repos.get(repo)) errors.push(`references/primer.md: repo table claims ${rows.get(repo)} PR pages for ${repo} but ${repos.get(repo)} exist on disk (AC-10)`);
  return errors;
}
export function sha256_of_file(filename) { return hash(readFileSync(filename)); }
export function* discover_bundle_roots() {
  if (!is_dir(ARTIFACTS_DIR)) return;
  const dirs = directory => children(directory).filter(is_dir);
  for (const repo of dirs(path.join(ARTIFACTS_DIR, 'prs'))) for (const pr of dirs(repo)) if (path.basename(pr).startsWith('PR-')) yield pr;
  for (const contest of dirs(path.join(ARTIFACTS_DIR, 'contests'))) for (const problem of dirs(contest)) yield* dirs(path.join(problem, 'submissions'));
  for (const blog of dirs(path.join(ARTIFACTS_DIR, 'blogs'))) if (is_dir(path.join(blog, 'code'))) yield path.join(blog, 'code');
  for (const slug of dirs(path.join(ARTIFACTS_DIR, 'kernels'))) for (const sub of ['full', 'variants']) if (is_dir(path.join(slug, sub))) yield path.join(slug, sub);
}
export function find_orphan_source_files() {
  const roots = [...discover_bundle_roots()], exclude = new Set(['MANIFEST.yaml', 'approach.md', 'bench.txt']);
  return [...walk(ARTIFACTS_DIR)].filter(filename => is_file(filename) && ASSET_SOURCE_EXTS.has(path.extname(filename).toLowerCase()) && !exclude.has(path.basename(filename)) && !roots.some(root => contains(root, filename)));
}

export function validate_bundle(bundle_root, known_source_ids) {
  const rel = relpath(bundle_root), errors = [], prov_path = path.join(bundle_root, 'PROVENANCE.yaml');
  if (!is_file(prov_path)) return [`${rel}: asset bundle missing PROVENANCE.yaml`];
  for (const extra of walk(bundle_root)) if (path.basename(extra) === 'PROVENANCE.yaml' && extra !== prov_path) errors.push(`${relpath(extra)}: nested PROVENANCE.yaml disallowed (flat ownership)`);
  let prov;
  try { prov = load_yaml_file(prov_path); } catch (error) { if (error.code) throw error; return [...errors, `${rel}/PROVENANCE.yaml: YAML parse error: ${error.message}`]; }
  if (!mapping(prov)) return [...errors, `${rel}/PROVENANCE.yaml: top-level must be a mapping`];
  for (const req of ['origin_url', 'upstream_repo', 'license', 'retrieved_at', 'asset_mode', 'files']) if (!(req in prov)) errors.push(`${rel}/PROVENANCE.yaml: missing required '${req}'`);
  const mode = get(prov, 'asset_mode');
  if (!['verbatim', 'extracted', 'derived'].includes(mode)) errors.push(`${rel}/PROVENANCE.yaml: asset_mode '${str(mode)}' must be one of verbatim/extracted/derived`);
  if (mode === 'derived') {
    if (!truth(prov.derived_from) || !Array.isArray(prov.derived_from)) errors.push(`${rel}/PROVENANCE.yaml: asset_mode=derived requires derived_from list`);
    else for (const sid of prov.derived_from) if (!known_source_ids.has(sid)) errors.push(`${rel}/PROVENANCE.yaml: derived_from '${str(sid)}' not a known source id`);
  } else if (mode === 'verbatim' && !truth(prov.upstream_sha)) errors.push(`${rel}/PROVENANCE.yaml: asset_mode=verbatim requires upstream_sha`);
  const parts = rel.split('/');
  if (parts.length >= 2 && parts[0] === 'artifacts') {
    const variants = parts.length >= 3 && parts[1] === 'kernels' && parts.at(-1) === 'variants';
    if (mode === 'derived' && !variants) errors.push(`${rel}: asset_mode=derived only allowed under artifacts/kernels/*/variants/`);
    if (!variants && ['prs', 'contests'].includes(parts[1]) && !['verbatim', 'extracted'].includes(mode)) errors.push(`${rel}: bundles under artifacts/${parts[1]}/** must use asset_mode verbatim or extracted`);
  }
  let files = truth(prov.files) ? prov.files : [];
  if (!Array.isArray(files)) { errors.push(`${rel}/PROVENANCE.yaml: files must be a list`); files = []; }
  const declared = new Set();
  let total = 0;
  for (const [i, entry] of files.entries()) {
    if (!mapping(entry)) { errors.push(`${rel}/PROVENANCE.yaml: files[${i}] must be a mapping`); continue; }
    const lp = entry.local_path, role = get(entry, 'role'), entry_mode = get(entry, 'mode'), sha = entry.sha256;
    if (!truth(lp)) { errors.push(`${rel}/PROVENANCE.yaml: files[${i}] missing local_path`); continue; }
    if (!['pr-diff', 'upstream-file', 'extracted-block', 'derived-source', 'approach-notes', 'bench-record'].includes(role)) errors.push(`${rel}/PROVENANCE.yaml: files[${i}].role '${str(role)}' not in allowed set`);
    if (!['verbatim', 'extracted', 'derived', 'upstream-patch'].includes(entry_mode)) errors.push(`${rel}/PROVENANCE.yaml: files[${i}].mode '${str(entry_mode)}' not in allowed set`);
    if (!truth(sha)) errors.push(`${rel}/PROVENANCE.yaml: files[${i}] missing sha256`);
    const filename = path.resolve(bundle_root, lp);
    if (!is_file(filename)) { errors.push(`${rel}/PROVENANCE.yaml: files[${i}].local_path '${lp}' does not exist in bundle`); continue; }
    let actual_path;
    try {
      actual_path = resolved(filename);
      const root = resolved(bundle_root);
      if (!contains(root, actual_path)) { errors.push(`${rel}/PROVENANCE.yaml: files[${i}].local_path '${lp}' escapes the bundle root (resolves to '${actual_path}', outside '${root}')`); continue; }
    } catch (error) { errors.push(`${rel}/PROVENANCE.yaml: files[${i}].local_path '${lp}' could not be resolved: ${error.message}`); continue; }
    declared.add(actual_path);
    const truncated = truth(entry.size_cap_truncated);
    if (truth(sha) && !truncated) {
      const actual = sha256_of_file(filename);
      if (actual !== sha) errors.push(`${rel}/PROVENANCE.yaml: files[${i}] sha256 mismatch (got ${actual.slice(0, 12)}..., declared ${str(sha).slice(0, 12)}...)`);
    }
    const size = statSync(filename).size;
    total += size;
    if (size > FILE_SIZE_CAP_BYTES && !truncated) errors.push(`${rel}/PROVENANCE.yaml: files[${i}] local_path '${lp}' is ${size} bytes (> ${FILE_SIZE_CAP_BYTES} cap); set size_cap_truncated: true or split`);
    if (entry_mode === 'extracted' && !truth(entry.heading_path)) errors.push(`${rel}/PROVENANCE.yaml: files[${i}].mode=extracted requires heading_path`);
  }
  if (total > BUNDLE_SIZE_CAP_BYTES && !truth(prov.size_cap_truncated)) errors.push(`${rel}: bundle aggregate is ${total} bytes (> ${BUNDLE_SIZE_CAP_BYTES} cap); set PROVENANCE.yaml size_cap_truncated: true or downgrade the bundle`);
  for (const filename of walk(bundle_root)) {
    if (!is_file(filename) || path.basename(filename) === 'PROVENANCE.yaml') continue;
    if (ASSET_SOURCE_EXTS.has(path.extname(filename).toLowerCase()) && !declared.has(resolved(filename))) errors.push(`${relpath(filename)}: source file present in bundle but not listed in ${rel}/PROVENANCE.yaml files[*] (manifest drift)`);
  }
  return errors;
}

export function main() {
  const tags = load_yaml_file(path.join(DATA_DIR, 'tags.yaml')), schemas = load_yaml_file(path.join(DATA_DIR, 'schemas.yaml'));
  const errors = [], ids = new Map(), languages = _load_code_langs(), source_ids = new Set(), known_ids = new Set();
  const sources = markdown(SOURCES_DIR), wiki = markdown(WIKI_DIR);
  for (const filename of sources) { const fm = extract_frontmatter(filename); if (mapping(fm) && 'id' in fm) source_ids.add(fm.id); }
  for (const id of source_ids) known_ids.add(id);
  for (const filename of wiki) { const fm = extract_frontmatter(filename); if (mapping(fm) && 'id' in fm) known_ids.add(fm.id); }
  for (const filename of [...sources, ...wiki]) {
    const fm = extract_frontmatter(filename);
    if (mapping(fm) && 'id' in fm) {
      if (ids.has(fm.id)) errors.push(`${relpath(filename)}: duplicate id '${str(fm.id)}' (also in ${ids.get(fm.id)})`);
      else ids.set(fm.id, relpath(filename));
    }
    errors.push(...validate_file(filename, schemas, tags, source_ids, languages));
  }
  let bundle_count = 0;
  const modes = { verbatim: 0, extracted: 0, derived: 0 };
  for (const root of discover_bundle_roots()) {
    bundle_count++;
    errors.push(...validate_bundle(root, known_ids));
    const filename = path.join(root, 'PROVENANCE.yaml');
    if (is_file(filename)) try { const mode = load_yaml_file(filename)?.asset_mode; if (Object.hasOwn(modes, mode)) modes[mode]++; } catch (error) { if (error.code) throw error; }
  }
  const orphans = find_orphan_source_files();
  for (const orphan of orphans) errors.push(`${relpath(orphan)}: source file outside any recognized asset bundle`);
  const ledger_files = ledgers();
  for (const filename of ledger_files) errors.push(...validate_ledger(filename));
  errors.push(...validate_version_claims_registry(source_ids));
  for (const check of [validate_pr_architecture_receipt, validate_cap_reconstruction_receipt, validate_alias_contract, validate_inclusion_policy_scalars, validate_plan_supersession, validate_skip_audit_coverage, validate_refresh_cutoff_alignment, validate_refresh_subset, validate_captured_at_cutoff, validate_claim_bearing_pages_have_pointer, validate_plan_body_unchanged, validate_cutlass_dev_pinning, validate_discoverability]) errors.push(...check());
  console.log(`Validated ${sources.length + wiki.length} files (${source_ids.size} source IDs collected)`);
  if (bundle_count || orphans.length) console.log(`Validated ${bundle_count} asset bundles (verbatim=${modes.verbatim}, extracted=${modes.extracted}, derived=${modes.derived}, orphan-source-files=${orphans.length})`);
  if (ledger_files.length) console.log(`Validated ${ledger_files.length} candidate ledgers`);
  if (errors.length) {
    console.log(`\n${errors.length} errors found:\n`);
    for (const error of errors) console.log(`  ERROR: ${error}`);
    return 1;
  }
  console.log('All files valid.');
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
