#!/usr/bin/env node
/** Pure evidence-based architecture, scope, metadata, and PR body policy. */
import { createHash } from "node:crypto";
import path from "node:path";

export const BODY_CONTRACT = "upstream-pr-v1";
export const UPSTREAM_EXCERPT_LIMIT = 1200;
export const ARCHITECTURE_FAMILY_PREFIXES = {
  turing: ["sm75"],
  ampere: ["sm80", "sm86", "sm87", "sm88"],
  ada: ["sm89"],
  hopper: ["sm90"],
  blackwell: ["sm100", "sm103", "sm110", "sm120", "sm121"],
};
export const BLACKWELL_EXACT_PREFIXES = ARCHITECTURE_FAMILY_PREFIXES.blackwell;
export const SUPPORTED_EXACT_ARCHITECTURES = [
  "sm75", "sm80", "sm86", "sm87", "sm88", "sm89", "sm90", "sm90a",
  "sm100", "sm100a", "sm100f", "sm103", "sm103a", "sm103f",
  "sm110", "sm110a", "sm110f", "sm120", "sm120a", "sm120f",
  "sm121", "sm121a", "sm121f",
];
const _SUPPORTED_EXACT_ARCHITECTURE_SET = new Set(SUPPORTED_EXACT_ARCHITECTURES);

export const PRODUCT_ARCHITECTURE_MAPPINGS = {
  b200: ["sm100", "https://developer.nvidia.com/cuda/gpus"],
  gb200: ["sm100", "https://developer.nvidia.com/cuda/gpus"],
  b300: ["sm103", "https://developer.nvidia.com/cuda/gpus"],
  gb300: ["sm103", "https://developer.nvidia.com/cuda/gpus"],
  h100: ["sm90", "https://developer.nvidia.com/cuda/gpus"],
  h200: ["sm90", "https://developer.nvidia.com/cuda/gpus"],
  gh200: ["sm90", "https://developer.nvidia.com/cuda/gpus"],
  h800: ["sm90", "https://docs.omniverse.nvidia.com/dang/latest/common/technical-requirements.html"],
  h20: ["sm90", "https://docs.nvidia.com/datacenter/tesla/mig-user-guide/supported-gpus.html"],
  a100: ["sm80", "https://developer.nvidia.com/cuda/gpus"],
};

// Keep the original Python pattern text separate from RegExp's representation:
// receipt hashes include that exact text and Python's re.I | re.UNICODE = 34.
const _PYTHON_DSL_SOURCES = {
  triton: String.raw`@(?:triton\.)?(?:jit|autotune|heuristics)\b|@triton\.jit\b|\btriton\.language\b|\btl\.[a-z_]\w*\s*\(`,
  "cute-dsl": String.raw`@(?:cutlass\.)?cute\.(?:jit|kernel)\b|@cute\.(?:jit|kernel)\b|\bcute\.[a-z_]\w*\s*\(`,
  tilelang: String.raw`@T\.prim_func\b|@tilelang\.(?:jit|autotune)\b|\bT\.(?:Kernel|alloc_shared|gemm|copy|clear|Parallel|Pipelined)\s*\(`,
  "jax-pallas": String.raw`@(?:pl|pallas)\.kernel\b|\bpallas_call\s*\(`,
  cutile: String.raw`@cutile\.kernel\b|\bcutile\.compile\s*\(`,
};
const _CUDA_TRANSLATION_UNIT_DEVICE_SOURCE = String.raw`\b__global__\b|\b__device__\b|\b__shared__\b|\b__launch_bounds__\b|(?<!\.)\b(?:threadIdx|blockIdx|blockDim|gridDim)\s*\.\s*[xyz]\b|\basm\s+volatile\b|\bCUTLASS_DEVICE\b|\bCUTE_HOST_DEVICE\b|\b__CUDA_ARCH__\b|\btcgen05\b|\bwgmma\b|\bcute::[A-Za-z_]\w*|\bcutlass::arch::[A-Za-z_]\w*|\bmake_tiled_copy\s*\(`;

// Python regexes use Unicode word boundaries, including beside non-ASCII text.
const WORD = String.raw`[\p{L}\p{N}_]`;
function regex(source, flags = "i") {
  const boundary = `(?:(?<!${WORD})(?=${WORD})|(?<=${WORD})(?!${WORD}))`;
  return new RegExp(source.replaceAll(String.raw`\b`, boundary).replaceAll(String.raw`\w`, WORD), `${flags}u`);
}
const _PYTHON_DSL_PATTERNS = Object.fromEntries(
  Object.entries(_PYTHON_DSL_SOURCES).map(([key, source]) => [key, regex(source)]),
);
const _CUDA_TRANSLATION_UNIT_DEVICE_RE = regex(_CUDA_TRANSLATION_UNIT_DEVICE_SOURCE);
const _EXACT_SM_RE = /sm[_ -]?(75|80|86|87|88|89|90|100|103|110|120|121)([aAfF]?)(?![0-9])/gi;
const _FAMILY_PATTERNS = Object.fromEntries(Object.keys(ARCHITECTURE_FAMILY_PREFIXES).map(
  (family) => [family, new RegExp(`(?<![a-z0-9])${family}(?![a-z0-9])`, "i")],
));
const _PORTABLE_ARCH_ATOM_SUFFIX_RE = /^_(?:cp_async|bulk_copy|tma|mma|wgmma|ldmatrix|stmatrix|copy|load|store)(?:_|$)/i;
const _ARCHITECTURE_GUARD_LINE_RE = regex(String.raw`__CUDA_ARCH__|CUTE_ARCH_|CUTLASS_ARCH_|CUDA_ARCHITECTURES|(?:^|\W)(?:gencode|compute_capability|device_capability|supports?_sm[_-]?\d+|is_sm[_-]?\d+|get_sm_version|sm_version|target\s*[:=]\s*['"]?sm[_-]?\d+|architecture\s*[:=]\s*['"]?sm[_-]?\d+)`);
const _NUMERIC_CUDA_ARCH_RE = regex(String.raw`__CUDA_ARCH__\s*(?:==|>=)\s*(750|800|860|870|880|890|900|1000|1030|1100|1200|1210)\b`, "g");
const _NUMERIC_RUNTIME_ARCH_RE = regex(String.raw`(?:get_sm_version\s*\([^)]*\)|sm_version|compute_capability)\s*(?:==|>=)\s*(75|80|86|87|88|89|90|100|103|110|120|121)\b`, "gi");
const _TARGET_ASSERTION_RE = regex(String.raw`\b(?:requires?|supports?|supported|target(?:s|ed|ing)?|tuned|tested|optimized|available|works?|compile[ds]?|architecture|compute capability|dispatch|kernel)\b`);
const _COMMENTED_OUT_CODE_RE = regex(String.raw`^\s*(?://\s*|#\s+)(?:bool|if|elif|else|def|class|from|import|return|auto|const|constexpr|std::|[A-Za-z_]\w*\s*=)`);
const _NON_TARGET_ARCHITECTURE_BOUNDARY_RE = regex(String.raw`\b(?:less\s+than|below|older\s+than|prior\s+to|before)\s*$`);
const _NON_TARGET_PRODUCT_BOUNDARY_RE = regex(String.raw`\b(?:unless|except)\s+(?:when\s+)?(?:running\s+)?(?:in|on|with)\s*$`);
const _PRODUCT_RE = new RegExp(`(${Object.keys(PRODUCT_ARCHITECTURE_MAPPINGS).sort((a, b) => b.length - a.length).join("|")})(?![a-z0-9])`, "gi");
const _HARD_SCOPE_RE = /(?<![a-z0-9])(eplb|deep[ _-]?ep|dual[ _-]?pipe)(?![a-z0-9])/i;
const _DISTRIBUTED_SCOPE_RE = /(?<![a-z0-9])(?:all[ _-]?reduce|all[ _-]?to[ _-]?all|alltoall|nvshmem|mnnvl|symmetric[ _-]?mem(?:ory)?|multi[ _-]?node|multi[ _-]?gpu|communication[ _-]?kernels?|eplb|deep[ _-]?ep|dual[ _-]?pipe)(?![a-z0-9])/i;
const _NON_IMPLEMENTATION_SEGMENTS = new Set(["test", "tests", "testing", "benchmark", "benchmarks", "bench", "docs", "doc", ".github", "ci", "examples_tests", "cpu"]);
const _STRONG_DEVICE_EXTENSIONS = new Set([".cu", ".cuh", ".ptx"]);
const _DEVICE_SIGNAL_EXTENSIONS = new Set([".cc", ".cpp", ".cxx", ".h", ".hpp", ".inl", ".jinja"]);
const _EXPLICIT_PYTHON_KERNEL_PATH_RE = /(?:^|\/)(?:triton_kernels?|cute_dsl(?:_kernels?)?|cutedsl(?:_kernels?)?|CuTeDSL|tilelang_kernels?)(?:\/|$)/i;
const _WEAK_KERNEL_TUNING_RE = regex(String.raw`\b(?:block_[mnk]|num_warps)\b`);
const _DEVICE_CODE_RE = regex(String.raw`\b__global__\b|\b__device__\b|\bCUTLASS_DEVICE\b|\bCUTE_HOST_DEVICE\b|\b__CUDA_ARCH__\b|\btcgen05\b|\bwgmma\b|\bcute::[A-Za-z_]\w*|\bcutlass::arch::[A-Za-z_]\w*|\bmake_tiled_copy\s*\(|\b(?:GemmType|TiledMma|TileShape|CollectiveBuilder)\b`);
const _C_CPP_NON_CODE_RE = /\/\/[^\n]*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const splitlines = (text) => {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
};
const pyWhitespace = /^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/gu;
const strip = (text) => text.replace(pyWhitespace, "");
const rstrip = (text) => text.replace(/[\s\x1c-\x1f\x85]+$/u, "");
const basename = (value) => path.posix.basename(value.replace(/\/+$/u, ""));
const suffix = (value) => {
  const extension = path.posix.extname(basename(value));
  return extension === "." ? "" : extension.toLowerCase();
};
function compare(a, b) {
  const aa = Array.from(a, (c) => c.codePointAt(0));
  const bb = Array.from(b, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
}
const sorted = (items) => Array.from(items).sort(compare);
const uniqueSorted = (items) => sorted(new Set(items));
const isMapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const truthy = (value) => Boolean(value) && (!(Array.isArray(value) || isMapping(value)) || Object.keys(value).length > 0);
const pyStr = (value) => value === null ? "None" : value === true ? "True" : value === false ? "False" : String(value);
function repr(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = Array.from(value, (char) => {
    if (char === quote || char === "\\") return `\\${char}`;
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    if (/[^\p{C}\p{Z}]/u.test(char) || char === " ") return char;
    const cp = char.codePointAt(0);
    return cp < 256 ? `\\x${cp.toString(16).padStart(2, "0")}` : cp < 65536 ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\U${cp.toString(16).padStart(8, "0")}`;
  }).join("");
  return quote + escaped + quote;
}

function _c_cpp_code_only(text) {
  return (text || "").replace(_C_CPP_NON_CODE_RE, " ");
}

function _python_code_only(text) {
  // A small lexer for tokenize.COMMENT and tokenize.STRING. Like generate_tokens,
  // incomplete brackets/triple strings/continuations and inconsistent dedents
  // fall back to removing full-line comments from the original partial hunk.
  const source = text || "";
  const chars = source.split("");
  const indents = [0];
  let brackets = 0;
  let lineStart = true;
  let continued = false;
  const fallback = () => splitlines(source).map((line) => strip(line).startsWith("#") ? "" : line).join("\n");
  const erase = (start, end) => {
    for (let pos = start; pos < end; pos++) if (chars[pos] !== "\r" && chars[pos] !== "\n") chars[pos] = " ";
  };
  for (let index = 0; index < source.length;) {
    if (lineStart) {
      let end = index;
      let indent = 0;
      while (/[ \t\f]/u.test(source[end] || "\0")) {
        if (source[end] === "\t") indent = (Math.floor(indent / 8) + 1) * 8;
        else if (source[end] === "\f") indent = 0;
        else indent++;
        end++;
      }
      if (brackets <= 0 && !continued && !["#", "\r", "\n", undefined].includes(source[end])) {
        if (indent > indents.at(-1)) indents.push(indent);
        else if (indent < indents.at(-1)) {
          while (indent < indents.at(-1)) indents.pop();
          if (indent !== indents.at(-1)) return fallback();
        }
      }
      index = end;
      lineStart = false;
      continued = false;
      if (index >= source.length) break;
    }
    const char = source[index];
    if (char === "\n") { lineStart = true; index++; continue; }
    if (char === "#") {
      let end = source.indexOf("\n", index);
      if (end === -1) end = source.length;
      erase(index, end);
      index = end;
      continue;
    }
    if (char === "\\" && (source[index + 1] === "\n" || source.slice(index + 1, index + 3) === "\r\n")) {
      index += source[index + 1] === "\r" ? 3 : 2;
      if (index >= source.length) return fallback();
      lineStart = true;
      continued = true;
      continue;
    }
    let quoteIndex = index;
    if (/[A-Za-z_\p{L}]/u.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\p{L}\p{N}_]/u.test(source[end])) end++;
      const prefix = source.slice(index, end).toLowerCase();
      if (["r", "u", "b", "f", "br", "rb", "fr", "rf"].includes(prefix) && /['"]/u.test(source[end] || "\0")) quoteIndex = end;
      else { index = end; continue; }
    }
    const quote = source[quoteIndex];
    if (quote === "'" || quote === '"') {
      const triple = source.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3);
      const delimiter = quote.repeat(triple ? 3 : 1);
      let end = quoteIndex + delimiter.length;
      let closed = false;
      while (end < source.length) {
        if (source[end] === "\\") { end += source[end + 1] === "\r" && source[end + 2] === "\n" ? 3 : 2; continue; }
        if (source.startsWith(delimiter, end)) { end += delimiter.length; closed = true; break; }
        if (!triple && source[end] === "\n") break;
        end++;
      }
      if (closed) { erase(index, end); index = end; continue; }
      if (triple || /\\\r?\n/u.test(source.slice(quoteIndex, end))) return fallback();
      // An unterminated single-quoted literal is an ERRORTOKEN, not STRING.
      index = quoteIndex + 1;
      continue;
    }
    if ("([{".includes(char)) brackets++;
    if (")]}".includes(char)) brackets--;
    index++;
  }
  return brackets > 0 ? fallback() : chars.join("");
}

export function cuda_translation_unit_device_signal(text) {
  return _CUDA_TRANSLATION_UNIT_DEVICE_RE.test(_c_cpp_code_only(text));
}
export function device_code_pattern_sha256() {
  return sha256(`cuda-source-code-only-v2\0${_CUDA_TRANSLATION_UNIT_DEVICE_SOURCE}\0${34}`);
}
export function python_dsl_languages(text) {
  const code = _python_code_only(text);
  return sorted(Object.keys(_PYTHON_DSL_PATTERNS).filter((language) => _PYTHON_DSL_PATTERNS[language].test(code)));
}
export function python_dsl_pattern_sha256() {
  const raw = ["python-token-code-only-v1"];
  for (const language of sorted(Object.keys(_PYTHON_DSL_SOURCES))) raw.push(language, _PYTHON_DSL_SOURCES[language], "34");
  return sha256(raw.join("\0"));
}
export class ScopeDecision {
  constructor(retain, disposition, rule, evidence_paths, reason) {
    Object.assign(this, { retain, disposition, rule, evidence_paths: Object.freeze([...evidence_paths]), reason });
    Object.freeze(this);
  }
}
export function normalize_files(files) {
  const normalized = [];
  for (const item of files || []) {
    if (typeof item === "string") normalized.push({ filename: item, patch: "" });
    else if (isMapping(item)) {
      const filename = item.filename || item.path;
      if (truthy(filename)) normalized.push({ ...item, filename: pyStr(filename), patch: item.patch || "" });
    }
  }
  return normalized;
}

function shellSplit(text) {
  const words = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && quote !== "'") {
      if (++index === text.length) throw new Error("No escaped character");
      if (quote === '"' && !['"', "\\"].includes(text[index])) current += "\\";
      current += text[index]; started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char; started = true;
    } else if (/[ \t\r\n]/u.test(char)) {
      if (started) words.push(current);
      current = ""; started = false;
    } else { current += char; started = true; }
  }
  if (quote) throw new Error("No closing quotation");
  if (started) words.push(current);
  return words;
}
export function parse_git_diff_files(diff_text) {
  const text = diff_text || "";
  const starts = [...text.matchAll(/^diff --git (.+)$/gm)];
  return starts.map((match, index) => {
    const section = text.slice(match.index, starts[index + 1]?.index ?? text.length).replace(/\n+$/u, "");
    let header;
    try { header = shellSplit(match[0]); }
    catch (cause) { throw new Error(`invalid diff header: ${repr(match[0])}`, { cause }); }
    if (header.length !== 4 || header[0] !== "diff" || header[1] !== "--git") throw new Error(`invalid diff header: ${repr(match[0])}`);
    const [old_path, new_path] = header.slice(2);
    let filename = new_path.startsWith("b/") ? new_path.slice(2) : new_path;
    let status = "modified";
    if (/^new file mode /m.test(section)) status = "added";
    else if (/^deleted file mode /m.test(section)) {
      status = "removed";
      filename = old_path.startsWith("a/") ? old_path.slice(2) : old_path;
    } else if (/^rename (?:from|to) /m.test(section)) status = "renamed";
    const lines = splitlines(section);
    return {
      filename, status,
      additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
      patch: section,
    };
  });
}
export function added_patch_text(patch) {
  return splitlines(patch || "").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
}
export function changed_implementation_text(patch) {
  const result = [];
  let in_block_comment = false;
  for (const line of splitlines(patch || "")) {
    if (!(line.startsWith("+") || line.startsWith("-")) || line.startsWith("+++") || line.startsWith("---")) continue;
    const value = strip(line.slice(1));
    if (!value) continue;
    if (in_block_comment) { if (value.includes("*/")) in_block_comment = false; continue; }
    if (value.startsWith("/*")) { if (!value.slice(2).includes("*/")) in_block_comment = true; continue; }
    if (["//", "*", "# SPDX-", "SPDX-"].some((prefix) => value.startsWith(prefix))) continue;
    result.push(value);
  }
  return result.join("\n");
}
export function cuda_requires_complete_evidence(item) {
  if (suffix(pyStr(item.filename || item.path || "")) !== ".cu") return false;
  if (["removed", "deleted"].includes(pyStr(item.status || item.changeType || "").toLowerCase())) return false;
  const patch = item.patch || "";
  if (patch && !changed_implementation_text(patch)) return false;
  return !cuda_translation_unit_device_signal(added_patch_text(patch));
}
export function python_requires_complete_evidence(item) {
  const filename = pyStr(item.filename || item.path || "");
  if (suffix(filename) !== ".py") return false;
  if (["removed", "deleted"].includes(pyStr(item.status || item.changeType || "").toLowerCase())) return false;
  if (_path_is_non_implementation(filename) || _path_is_distributed_implementation(filename)) return false;
  if (_EXPLICIT_PYTHON_KERNEL_PATH_RE.test(filename) && basename(filename).toLowerCase() !== "__init__.py") return false;
  const added = added_patch_text(item.patch || "");
  if (python_dsl_languages(added).length) return false;
  return _WEAK_KERNEL_TUNING_RE.test(_python_code_only(added));
}
export function complete_file_device_signal(item) {
  return item.complete_file_evidence_complete === true
    && /^[0-9a-f]{64}$/u.test(pyStr(item.complete_file_sha256 ?? ""))
    && item.complete_file_device_pattern_sha256 === device_code_pattern_sha256()
    && item.complete_file_device_signal === true;
}
export function complete_file_python_dsl_signal(item) {
  const languages = item.complete_file_python_dsl_languages;
  return item.complete_file_python_dsl_evidence_complete === true
    && /^[0-9a-f]{64}$/u.test(pyStr(item.complete_file_python_dsl_sha256 ?? ""))
    && item.complete_file_python_dsl_pattern_sha256 === python_dsl_pattern_sha256()
    && item.complete_file_python_dsl_signal === true
    && Array.isArray(languages) && languages.length > 0
    && languages.every((value, index) => value === uniqueSorted(languages)[index] && Object.hasOwn(_PYTHON_DSL_PATTERNS, value));
}
export function _path_is_non_implementation(filename) {
  const name = basename(filename).toLowerCase();
  return filename.split("/").some((part) => _NON_IMPLEMENTATION_SEGMENTS.has(part.toLowerCase())) || name.startsWith("test_") || name.includes("_test.");
}
export function _path_is_distributed_implementation(filename) {
  const compact = filename.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return ["allreduce", "alltoall", "nvshmem", "mnnvl", "symmetricmemory", "multinode", "multigpu", "communicationkernel", "commops", "eplb", "deepep", "dualpipe"].some((token) => compact.includes(token));
}
export function classify_scope(title, body, files) {
  const normalized = normalize_files(files);
  const hard_match = _HARD_SCOPE_RE.exec(title || "");
  const distributed_match = _DISTRIBUTED_SCOPE_RE.exec(title || "");
  if (hard_match || distributed_match) {
    const match = hard_match || distributed_match;
    return new ScopeDecision(false, "removed", hard_match ? "hard-distributed-system-exclusion" : "distributed-system-implementation-exclusion", [], `remove: distributed-system topic matched ${repr(match[0])} in PR title`);
  }
  const strong_paths = [], python_paths = [], signaled_paths = [], excluded_paths = [];
  for (const item of normalized) {
    const filename = item.filename;
    if (_path_is_non_implementation(filename)) continue;
    if (_path_is_distributed_implementation(filename)) { excluded_paths.push(filename); continue; }
    const extension = suffix(filename);
    const added = added_patch_text(item.patch || "");
    if (_STRONG_DEVICE_EXTENSIONS.has(extension)) {
      if (["removed", "deleted"].includes(pyStr(item.status || item.changeType || "").toLowerCase())) continue;
      if (item.patch && !changed_implementation_text(item.patch)) continue;
      if (extension === ".cu" && cuda_requires_complete_evidence(item) && !complete_file_device_signal(item)) continue;
      strong_paths.push(filename);
      continue;
    }
    if (extension === ".py") {
      const explicit = _EXPLICIT_PYTHON_KERNEL_PATH_RE.test(filename) && basename(filename).toLowerCase() !== "__init__.py";
      if (explicit || python_dsl_languages(added).length || (python_requires_complete_evidence(item) && complete_file_python_dsl_signal(item))) { python_paths.push(filename); continue; }
    }
    if (_DEVICE_SIGNAL_EXTENSIONS.has(extension) && _DEVICE_CODE_RE.test(added)) signaled_paths.push(filename);
  }
  for (const [paths, rule, reason] of [
    [strong_paths, "cuda-cute-ptx-device-source", "retain: CUDA/CuTe/PTX device implementation path(s): "],
    [python_paths, "python-dsl-device-kernel", "retain: Python DSL device-kernel implementation added in: "],
    [signaled_paths, "device-code-signal", "retain: added device-code construct in: "],
  ]) if (paths.length) {
    const evidence_paths = uniqueSorted(paths);
    return new ScopeDecision(true, "retained", rule, evidence_paths, reason + evidence_paths.join(", "));
  }
  if (excluded_paths.length) {
    const paths = uniqueSorted(excluded_paths);
    return new ScopeDecision(false, "removed", "distributed-system-implementation-exclusion", paths, "remove: only distributed-system implementation path(s) qualified: " + paths.join(", "));
  }
  return new ScopeDecision(false, "removed", "no-positive-device-kernel-evidence", [], `remove: no positive device-kernel implementation in ${normalized.length} authoritative changed file(s)`);
}

function _strip_architecture_boilerplate(body) {
  return (body || "").replace(/<!-- This is an auto-generated comment:.*?<!-- end of auto-generated comment:.*?-->/gis, "").replace(/<!--.*?-->/gs, "").split(/^## GitHub Bot Help\s*$/m, 1)[0];
}
function* _evidence_fragments(title, body, files, implementation_paths = []) {
  yield ["PR title", title || ""];
  yield ["PR description", _strip_architecture_boilerplate(body)];
  const paths = new Set(implementation_paths);
  for (const item of normalize_files(files)) {
    const filename = item.filename;
    yield [`changed-path:${filename}`, filename];
    const lines = splitlines(added_patch_text(item.patch || ""));
    const guards = lines.filter((line) => _ARCHITECTURE_GUARD_LINE_RE.test(line) && !_COMMENTED_OUT_CODE_RE.test(line));
    if (guards.length) yield [`architecture-guard:${filename}`, guards.join("\n")];
    const signals = [];
    for (const line of lines) {
      if (line.trimStart().startsWith("#include") || _COMMENTED_OUT_CODE_RE.test(line)) continue;
      const has_signal = new RegExp(_EXACT_SM_RE).test(line) || new RegExp(_PRODUCT_RE).test(line) || Object.values(_FAMILY_PATTERNS).some((pattern) => pattern.test(line));
      if (has_signal && (paths.has(filename) || _TARGET_ASSERTION_RE.test(line))) signals.push(line);
    }
    if (signals.length) yield [`added-patch:${filename}`, signals.join("\n")];
  }
}
function* _iter_exact_sm(text) {
  for (const match of text.matchAll(_EXACT_SM_RE)) {
    const start = match.index, end = start + match[0].length;
    const before = Array.from(text.slice(0, start)).at(-1) || "";
    const after = Array.from(text.slice(end))[0] || "";
    const spelling = text.slice(start, start + 2);
    const camel_case = spelling.startsWith("S") && (/\p{Ll}/u.test(before) || spelling === "SM");
    if (/[\p{L}\p{N}]/u.test(before) && !camel_case) continue;
    if (/[\p{L}\p{N}]/u.test(after)) {
      if (!/\p{Lu}/u.test(after)) continue;
      if (spelling === "SM" && !/^[A-Z][a-z]/u.test(text.slice(end))) continue;
    }
    const architecture = "sm" + match[1] + match[2].toLowerCase();
    if (!_SUPPORTED_EXACT_ARCHITECTURE_SET.has(architecture) || _PORTABLE_ARCH_ATOM_SUFFIX_RE.test(text.slice(end))) continue;
    yield match;
  }
}
function* _iter_products(text) {
  for (const match of text.matchAll(_PRODUCT_RE)) {
    const start = match.index;
    const before = Array.from(text.slice(0, start)).at(-1) || "";
    if (/\p{L}/u.test(before)) {
      if (!(before.toLowerCase() === "x" && start >= 2 && /\p{N}/u.test(text[start - 2]))) continue;
    } else if (/\p{N}/u.test(before)) continue;
    if (_NON_TARGET_PRODUCT_BOUNDARY_RE.test(text.slice(Math.max(0, start - 64), start))) continue;
    yield match;
  }
}
function _family_for_exact(architecture) {
  return Object.keys(ARCHITECTURE_FAMILY_PREFIXES).find((family) => ARCHITECTURE_FAMILY_PREFIXES[family].some((prefix) => architecture.startsWith(prefix))) ?? null;
}
export function derive_architectures(title, body, files) {
  let exact_evidence = new Map(), family_evidence = new Map();
  const normalized = normalize_files(files);
  const scope = classify_scope(title, body, normalized);
  const fragments = [..._evidence_fragments(title, body, normalized, scope.evidence_paths)];
  const add = (architecture, row) => {
    if (!exact_evidence.has(architecture)) exact_evidence.set(architecture, []);
    exact_evidence.get(architecture).push(row);
  };
  function record_fragment(locator, text, include_numeric_guards = false) {
    for (const match of _iter_exact_sm(text)) {
      if (locator !== "PR title" && _NON_TARGET_ARCHITECTURE_BOUNDARY_RE.test(text.slice(Math.max(0, match.index - 48), match.index))) continue;
      const architecture = "sm" + match[1] + match[2].toLowerCase();
      add(architecture, { architecture, basis: "exact-sm-token", locator, evidence: match[0] });
    }
    for (const match of _iter_products(text)) {
      const [architecture, mapping_source] = PRODUCT_ARCHITECTURE_MAPPINGS[match[1].toLowerCase()];
      add(architecture, { architecture, basis: "documented-product-mapping", locator, evidence: match[0], mapping_source });
    }
    for (const [family, pattern] of Object.entries(_FAMILY_PATTERNS)) {
      const match = pattern.exec(text);
      if (match && !family_evidence.has(family)) family_evidence.set(family, { architecture: family, basis: "explicit-family-name", locator, evidence: match[0] });
    }
    if (include_numeric_guards) for (const [pattern, scale, basis] of [
      [_NUMERIC_CUDA_ARCH_RE, 10, "cuda-arch-guard"],
      [_NUMERIC_RUNTIME_ARCH_RE, 1, "runtime-architecture-guard"],
    ]) for (const match of text.matchAll(pattern)) {
      const architecture = `sm${Math.floor(Number(match[1]) / scale)}`;
      add(architecture, { architecture, basis, locator, evidence: match[0] });
    }
  }
  for (const [locator, text] of fragments) if (!locator.startsWith("added-patch:")) record_fragment(locator, text);
  if (!exact_evidence.size && !family_evidence.size) for (const [locator, text] of fragments) {
    if (locator.startsWith("architecture-guard:") || locator.startsWith("added-patch:")) record_fragment(locator, text, true);
  }
  const title_exact = [...exact_evidence].filter(([, rows]) => rows.some((row) => row.locator === "PR title")).map(([architecture]) => architecture);
  if (title_exact.length === 1 && title_exact[0] === "sm75" && regex(String.raw`\b(?:support|turing)\b`).test(title)) {
    exact_evidence = new Map([["sm75", exact_evidence.get("sm75")]]);
    family_evidence = new Map([...family_evidence].filter(([family]) => family === "turing"));
  }
  if (exact_evidence.size) {
    const architectures = [...exact_evidence.keys()].sort((a, b) => Number(a.match(/^sm(\d+)/u)[1]) - Number(b.match(/^sm(\d+)/u)[1]) || compare(a, b));
    const evidence = [];
    for (const architecture of architectures) {
      const seen = new Set();
      for (const row of exact_evidence.get(architecture)) {
        const key = JSON.stringify([row.basis, row.locator, row.evidence]);
        if (!seen.has(key)) { evidence.push(row); seen.add(key); }
        if (seen.size >= 3) break;
      }
    }
    const families = new Set(architectures.map(_family_for_exact));
    const additional = sorted([...family_evidence.keys()].filter((family) => !families.has(family)));
    for (const family of additional) evidence.push(family_evidence.get(family));
    return [[...architectures, ...additional], additional.length ? "mixed" : "exact", evidence];
  }
  if (family_evidence.size) {
    const families = sorted(family_evidence.keys());
    return [families, "family", families.map((family) => family_evidence.get(family))];
  }
  return [[], "unknown", [{
    architecture: "unknown", basis: "no-discriminating-architecture-evidence",
    locator: `PR title, description, paths, and target-signaling additions in ${normalized.length} changed files`,
    evidence: "No qualifying target-architecture evidence survived the deterministic context filters.",
  }]];
}

const _HARDWARE_PATTERNS = {
  tcgen05: String.raw`(?<![a-z0-9])tcgen05(?![a-z0-9])`,
  tmem: String.raw`\b(?:tmem|tensor memory)\b`,
  tma: String.raw`\b(?:tma|tensor memory accelerator)\b`,
  clc: String.raw`\b(?:clc|cluster launch control)\b`,
  nvfp4: String.raw`\bnvfp4\b`, fp8: String.raw`\bfp8\b`, fp6: String.raw`\bfp6\b`,
  fp4: String.raw`\b(?:fp4|mxfp4|nvfp4)\b`,
  "block-scale": String.raw`\b(?:block[ _-]?scale|microscal)\w*`,
  wgmma: String.raw`\bwgmma\b`, mbarrier: String.raw`\bmbarrier\b`,
};
const _KERNEL_TYPE_PATTERNS = {
  "grouped-gemm": String.raw`\bgrouped[ _-]?gemm\b`, gemm: String.raw`\bgemm\b`, gemv: String.raw`\bgemv\b`,
  "flash-attention": String.raw`\b(?:flash[ _-]?attention|fmha)\b`,
  "sparse-attention": String.raw`\bsparse[ _-]?attention\b`, attention: String.raw`\battention\b|\bfmha\b`,
  mla: String.raw`\bmla\b|multi-head latent attention`, moe: String.raw`\bmoe\b|mixture of experts`,
  quantization: String.raw`\bquanti[sz]\w*`, topk: String.raw`\btop[ -]?k\b`,
  scan: String.raw`\b(?:BlockScan|WarpScan|exclusive[ _-]?scan|inclusive[ _-]?scan|prefix[ _-]?scan|parallel[ _-]?scan|scan[ _-]?(?:algorithm|kernel))\b`,
  reduction: String.raw`\breduct(?:ion|e)\b`, sort: String.raw`\b(?:sort|radix)\b`,
};
const _TECHNIQUE_PATTERNS = {
  "warp-specialization": String.raw`\bwarp[ _-]?speciali[sz]\w*`,
  "persistent-kernel": String.raw`\bpersistent[ _-]?(?:kernel|schedul)\w*`,
  swizzling: String.raw`\bswizzl\w*`, "pipeline-stages": String.raw`\bpipeline(?:d|s| stages?)?\b`,
  "double-buffering": String.raw`\bdouble[ _-]?buffer\w*`, "epilogue-fusion": String.raw`\bepilogue[ _-]?fusion\b`,
  "tile-scheduling": String.raw`\btile[ _-]?schedul\w*`,
  "kernel-fusion": String.raw`\b(?:kernel[ _-]?fusion|fused[ _-]?kernel|fuse kernels?)\b`, "stream-k": String.raw`\bstream[ -]?k\b`,
};
for (const patterns of [_HARDWARE_PATTERNS, _KERNEL_TYPE_PATTERNS, _TECHNIQUE_PATTERNS]) for (const [key, source] of Object.entries(patterns)) patterns[key] = regex(source);
export function derive_metadata(title, body, files, scope = null) {
  const normalized = normalize_files(files);
  scope ||= classify_scope(title, body, normalized);
  if (!scope.retain) return { tags: [], hardware_features: [], kernel_types: [], techniques: [], languages: [] };
  const paths = new Set(scope.evidence_paths);
  const semantic_parts = [title || "", body || ""];
  const languages = new Set();
  for (const item of normalized) {
    const filename = item.filename;
    if (!paths.has(filename)) continue;
    const added = added_patch_text(item.patch || "");
    semantic_parts.push(added, filename);
    const extension = suffix(filename);
    if ([".cu", ".cuh", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".inl", ".jinja"].includes(extension)) languages.add("cuda-cpp");
    if (extension === ".ptx") languages.add("ptx");
    if (extension === ".py") {
      for (const language of python_dsl_languages(added)) languages.add(language);
      if (complete_file_python_dsl_signal(item)) for (const language of item.complete_file_python_dsl_languages) languages.add(language);
      const lowered = filename.toLowerCase();
      if (lowered.includes("triton_kernel")) languages.add("triton");
      if (/(?:^|\/)(?:cute_dsl|cutedsl)(?:\/|_kernel)/u.test(lowered)) languages.add("cute-dsl");
      if (lowered.includes("tilelang_kernel")) languages.add("tilelang");
    }
  }
  const text = semantic_parts.join("\n").replace(regex(String.raw`\b(?:not compatible with|does not support|do not support|unsupported for)\b[^.\n]*`, "gi"), "");
  const matching = (patterns) => sorted(Object.keys(patterns).filter((tag) => patterns[tag].test(text)));
  const hardware_features = matching(_HARDWARE_PATTERNS), kernel_types = matching(_KERNEL_TYPE_PATTERNS);
  return { tags: uniqueSorted([...hardware_features, ...kernel_types]), hardware_features, kernel_types, techniques: matching(_TECHNIQUE_PATTERNS), languages: sorted(languages) };
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (isMapping(value)) return `{${sorted(Object.keys(value)).map((key) => `${sortedJson(key)}:${sortedJson(value[key])}`).join(",")}}`;
  // Python's default ensure_ascii=True encodes each UTF-16 unit, including pairs.
  return JSON.stringify(value ?? null).replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
export function upstream_files_sha256(files) {
  const canonical = normalize_files(files).map((item) => {
    const record = {
      filename: item.filename, status: item.status || item.changeType || "",
      additions: item.additions ?? null, deletions: item.deletions ?? null,
      patch_sha256: sha256(item.patch || ""),
    };
    if (cuda_requires_complete_evidence(item) && item.complete_file_evidence_complete === true) for (const key of [
      "complete_file_evidence_complete", "complete_file_sha256", "complete_file_device_signal", "complete_file_device_pattern_sha256",
    ]) record[key] = item[key] ?? null;
    if (python_requires_complete_evidence(item) && item.complete_file_python_dsl_evidence_complete === true) for (const key of [
      "complete_file_python_dsl_evidence_complete", "complete_file_python_dsl_sha256", "complete_file_python_dsl_signal", "complete_file_python_dsl_languages", "complete_file_python_dsl_pattern_sha256",
    ]) record[key] = item[key] ?? null;
    return record;
  });
  return sha256(sortedJson(canonical));
}
export function upstream_excerpt(body) {
  const canonical = (body || "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((line) => {
    line = line.replace(/[ \t]+$/u, "");
    return /^(?:<{7}|={7}|>{7})(?: |$)/u.test(line) ? "\\" + line : line;
  }).join("\n");
  const excerpt = rstrip(Array.from(strip(canonical)).slice(0, UPSTREAM_EXCERPT_LIMIT).join(""));
  return excerpt.replaceAll("<!-- upstream-excerpt-start -->", "&lt;!-- upstream-excerpt-start --&gt;").replaceAll("<!-- upstream-excerpt-end -->", "&lt;!-- upstream-excerpt-end --&gt;");
}
export function render_generated_body(body, changed_paths, total_files = null) {
  const excerpt = upstream_excerpt(body);
  const paths = [...changed_paths];
  const total = total_files === null ? paths.length : total_files;
  const lines = ["## Upstream PR description (verbatim excerpt)", "", "<!-- upstream-excerpt-start -->", excerpt || "_The upstream PR description is empty._", "<!-- upstream-excerpt-end -->", "", "## Changed files (upstream)", ""];
  for (const filename of paths) lines.push(`- \`${filename}\``);
  if (total > paths.length) lines.push(`- _${total - paths.length} additional changed file(s) omitted from this display._`);
  lines.push("");
  return [lines.join("\n"), sha256(excerpt)];
}
export function body_contract_errors(frontmatter, body) {
  if (frontmatter.body_contract !== BODY_CONTRACT) return [`body_contract must be ${repr(BODY_CONTRACT)}`];
  const errors = [];
  const start = "<!-- upstream-excerpt-start -->\n", end = "\n<!-- upstream-excerpt-end -->";
  if (body.split(start).length !== 2 || body.split(end).length !== 2) return ["generated body must contain exactly one upstream excerpt sentinel pair"];
  const startIndex = body.indexOf(start), endIndex = body.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error("not enough values to unpack (expected 2, got 1)");
  const prefix = body.slice(0, startIndex), rendered = body.slice(startIndex + start.length, endIndex), tail = body.slice(endIndex + end.length);
  if (prefix !== "## Upstream PR description (verbatim excerpt)\n\n") errors.push("generated body has text outside the upstream-pr-v1 prefix template");
  if (!tail.startsWith("\n\n## Changed files (upstream)\n\n")) errors.push("generated body has text outside the upstream-pr-v1 suffix template");
  const excerpt = rendered === "_The upstream PR description is empty._" ? "" : rendered;
  if (frontmatter.upstream_excerpt_sha256 !== sha256(excerpt)) errors.push("upstream_excerpt_sha256 does not match rendered upstream excerpt");
  if (!/^[0-9a-f]{64}$/u.test(pyStr(frontmatter.upstream_body_sha256 ?? ""))) errors.push("upstream_body_sha256 must be a full SHA-256 digest");
  if (!/^[0-9a-f]{64}$/u.test(pyStr(frontmatter.upstream_files_sha256 ?? ""))) errors.push("upstream_files_sha256 must be a full SHA-256 digest");
  const [expected] = render_generated_body(excerpt, frontmatter.changed_paths || [], frontmatter.changed_files_count ?? null);
  if (body !== expected) errors.push("generated body differs from the deterministic upstream-pr-v1 template");
  return errors;
}
export function architecture_matches_filter(architectures, disposition, requested) {
  const archs = new Set(Array.from(architectures || [], (value) => pyStr(value).toLowerCase()));
  requested = requested.toLowerCase().replaceAll("_", "");
  if (Object.hasOwn(PRODUCT_ARCHITECTURE_MAPPINGS, requested)) requested = PRODUCT_ARCHITECTURE_MAPPINGS[requested][0];
  if (requested === "unknown") return disposition === "unknown" && !archs.size;
  if (Object.hasOwn(ARCHITECTURE_FAMILY_PREFIXES, requested)) return archs.has(requested) || [...archs].some((value) => ARCHITECTURE_FAMILY_PREFIXES[requested].some((prefix) => value.startsWith(prefix)));
  return archs.has(requested);
}
