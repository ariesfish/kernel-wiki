import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as validate from "../scripts/validate.mjs";
import { parse } from "../scripts/lib/yaml.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (filename) => readFileSync(path.join(ROOT, filename), "utf8");
const yaml = (source) =>
  parse(source, {
    version: "1.1",
    uniqueKeys: false,
  });
const fm = (filename) =>
  filename.endsWith(".md")
    ? validate.extractFrontmatter(path.join(ROOT, filename))
    : yaml(read(filename));
const includes = (text, phrase) =>
  assert.ok(text.includes(phrase), `Missing ${JSON.stringify(phrase)}`);
const excludes = (text, phrase) =>
  assert.ok(!text.includes(phrase), `Unexpected ${JSON.stringify(phrase)}`);
const flat = (value) => value.split(/\s+/).filter(Boolean).join(" ");
function files(directory, predicate = (name) => name.endsWith(".md")) {
  return readdirSync(path.join(ROOT, directory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)))
    .sort();
}
function fixture(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "wiki-validator-")),
    previous = validate.REPO_ROOT;
  const write = (name, content) => {
    const filename = path.join(root, name);
    mkdirSync(path.dirname(filename), {
      recursive: true,
    });
    writeFileSync(filename, content);
    return filename;
  };
  validate.configureRoot(root);
  try {
    return callback({
      root,
      write,
    });
  } finally {
    validate.configureRoot(previous);
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
function validatePage(reproducibility) {
  return fixture(({ write }) => {
    const page = write(
      "wiki/techniques/example.md",
      `---\nid: technique-example\ntype: technique\nreproducibility: ${reproducibility}\n---\n\n# Evidence-bounded concept\n\nNo implementation is claimed.\n`,
    );
    return validate.validateFile(
      page,
      {
        "wiki-technique": {
          required: [],
          constraints: {
            reproducibility_minimum: "concept",
          },
        },
      },
      {
        reproducibility: validate.REPRO_ORDER,
      },
      new Set(),
      new Set(["python", "cuda"]),
    );
  });
}
test("concept page is not forced to invent code", () =>
  assert.ok(!validatePage("concept").some((error) => error.includes("fenced code block"))));
test("snippet claim still requires real code", () =>
  assert.ok(validatePage("snippet").some((error) => error.includes("fenced code block"))));
for (const [name, language, body, expected] of [
  [
    "typed cpp builder fragment counts as code",
    "cpp",
    "using Layout = decltype(Config::deduce_layout());\nusing Mainloop = typename Builder<Layout>::CollectiveOp;\nauto args = Mainloop::to_underlying_arguments(problem);",
    true,
  ],
  [
    "shell build comparison counts as code",
    "bash",
    "nvcc -arch=sm_100a kernel.cu -o default\nnvcc -arch=sm_100a --maxrregcount=80 kernel.cu -o r80\nnvcc -arch=sm_100a --maxrregcount=64 kernel.cu -o r64",
    true,
  ],
  [
    "exact two line API usage counts as code",
    "python",
    "from flash_attn.cute import flash_attn_func\nout = flash_attn_func(q, k, v, causal=True)",
    true,
  ],
  [
    "python control flow excerpt counts as code",
    "python",
    "if warp_idx < softmax_warp:\n    softmax_loop(stage=0)\nif warp_idx >= softmax_warp:\n    softmax_loop(stage=1)",
    true,
  ],
  ["one line stub does not count as code", "python", "out = implementation()", false],
]) {
  test(name, () =>
    assert.equal(
      validate.hasCompilableCode("```" + language + "\n" + body + "\n```", new Set([language])),
      expected,
    ),
  );
}
function cutoff(captured) {
  return fixture(({ write }) => {
    write("data/refresh-cutoff.yaml", "cutoff_date: 2026-08-01\nprevious_pages_manifest: []\n");
    write("sources/prs/example/PR-1.md", `---\nid: pr-example-1\ncaptured_at: ${captured}\n---\n`);
    return validate.validateCapturedAtCutoff();
  });
}
test("post cutoff capture is valid fresh evidence", () =>
  assert.deepEqual(cutoff("2026-08-18"), []));
test("pre cutoff capture is rejected for new page", () => {
  const errors = cutoff("2026-07-31");
  assert.equal(errors.length, 1);
  includes(errors[0], "precedes cutoff_date");
});
test("count gate covers repositories outside old hardcoded subset", () =>
  fixture(({ write }) => {
    for (const number of [1, 2]) {
      write(
        `sources/prs/cccl/PR-${number}.md`,
        `---\nid: pr-cccl-${number}\nrepo: NVIDIA/cccl\n---\n`,
      );
    }
    write(
      "references/primer.md",
      "## Source Repositories (PR coverage)\n\n| Repo | PR pages | Ledger |\n|---|---:|---|\n| NVIDIA/cccl | 3 | ledger |\n",
    );
    assert.ok(
      validate
        .validateDiscoverability()
        .some((error) => error.includes("NVIDIA/cccl") && error.includes("2 exist")),
    );
  }));
test("capped listing requires honest total and completeness", () => {
  const valid = {
    changed_files_count: 3750,
    changed_files_enumerated_count: 3000,
    changed_files_listing_complete: false,
    changed_paths: ["kernel.cu"],
    changed_paths_complete: false,
  };
  assert.deepEqual(validate.changedFileInventoryErrors(valid), []);
  includes(
    validate
      .changedFileInventoryErrors({
        ...valid,
        changed_files_count: 3000,
      })
      .join("\n"),
    "listing_complete",
  );
});
test("reconstructed evidence requires full count and receipt", () => {
  const valid = {
    changed_files_count: 3298,
    changed_files_enumerated_count: 3000,
    changed_files_listing_complete: false,
    changed_files_evidence_count: 3298,
    changed_files_evidence_complete: true,
    changed_files_evidence_method: "github-pull-diff",
    changed_files_evidence_receipt: "audit/pr-file-cap-reconstruction.json",
    changed_paths: ["src/tail_kernel.cu"],
    changed_paths_complete: false,
  };
  assert.deepEqual(validate.changedFileInventoryErrors(valid), []);
  includes(
    validate
      .changedFileInventoryErrors({
        ...valid,
        changed_files_evidence_count: 3000,
      })
      .join("\n"),
    "evidence_complete",
  );
});
test("reconstructed page must match policy receipt", () => {
  const page = {
    repo: "example/project",
    pr: 9,
    scope_disposition: "retained",
    scope_evidence: {
      rule: "device-code-signal",
      paths: ["src/tail.h"],
      path_source: "github-pull-diff",
    },
    changed_files_count: 3001,
    changed_files_enumerated_count: 3000,
    changed_files_listing_complete: false,
    changed_files_evidence_count: 3001,
    changed_files_evidence_complete: true,
    changed_files_evidence_method: "github-pull-diff",
    changed_files_evidence_receipt: "audit/pr-file-cap-reconstruction.json",
    upstream_files_sha256: "a".repeat(64),
  };
  const row = {
    authoritative_changed_files: 3001,
    files_api_enumerated: 3000,
    enumeration_complete: false,
    full_diff_paths: 3001,
    full_diff_complete: true,
    policy_files_sha256: "a".repeat(64),
    full_policy: {
      disposition: "retained",
      rule: "device-code-signal",
      evidence_paths: ["src/tail.h"],
    },
  };
  assert.deepEqual(validate.capReconstructionPageErrors(page, row), []);
  includes(
    validate
      .capReconstructionPageErrors(
        {
          ...page,
          upstream_files_sha256: "b".repeat(64),
        },
        row,
      )
      .join("\n"),
    "upstream_files_sha256",
  );
});
test("complete CUDA receipt binds content and policy pattern", () => {
  const row = {
    complete_file_evidence: [
      {
        path: "src/kernel.cu",
        sha256: "a".repeat(64),
        device_signal: true,
        device_pattern_sha256: validate.deviceCodePatternSha256(),
      },
    ],
  };
  assert.deepEqual(validate.capCompleteFileEvidenceErrors(row), []);
  row.complete_file_evidence[0].device_pattern_sha256 = "b".repeat(64);
  includes(validate.capCompleteFileEvidenceErrors(row).join("\n"), "stale");
});
test("tcgen05 tutorial uses source supported author identity", () => {
  const source = read("sources/blogs/tcgen05-tutorial.md"),
    pipeline = read("wiki/techniques/pipeline-stages.md"),
    persistent = read("wiki/techniques/persistent-kernels.md");
  includes(source, "author: Thien Tran (gau-nernst)");
  for (const text of [source, pipeline, persistent]) {
    excludes(text, "Gau Nernst");
  }
  for (const text of [pipeline, persistent]) {
    includes(text, "Thien Tran (`gau-nernst`)");
  }
});
test("flash attention blog credits all six authors", () => {
  const source = read("sources/blogs/flash-attention-4.md"),
    kernel = read("wiki/kernels/flash-attention-4.md"),
    examples = read("references/examples.md");
  includes(
    source,
    "author: Ted Zadouri, Markus Hoehnerbach, Jay Shah, Timmy Liu, Vijay Thakkar, and Tri Dao",
  );
  includes(source, "The FlashAttention-4 authors' article");
  for (const text of [source, kernel, examples]) {
    excludes(text, "Tri Dao's");
  }
  includes(kernel, "FlashAttention-4 author blog");
  includes(examples, "(author blog)");
});
test("qwen3 next uses the article byline not model organizations", () => {
  const source = read("sources/blogs/qwen3-next-architecture.md");
  includes(source, "author: Anu Srivastava (NVIDIA)");
  excludes(source, "author: NVIDIA / Alibaba");
});
test("modular blackwell post credits its four person byline", () => {
  const source = read("sources/blogs/modular-blackwell-matmul.md");
  includes(source, "author: Ali Taha, Jiexiang Liu, Hengjie Wang, and Abdul Dakkak (Modular)");
  excludes(source, "author: Modular\n");
});
test("NSA paper credits people and all three institutions", () => {
  const source = read("sources/docs/nsa.md"),
    kernel = read("wiki/kernels/nsa.md");
  includes(
    source,
    "author: Jingyang Yuan et al. (DeepSeek-AI, Peking University, University of Washington)",
  );
  for (const text of [source, kernel]) {
    includes(text, "DeepSeek-led");
    excludes(text, "DeepSeek's");
  }
});
test("hugging face community post uses rendered author identity", () => {
  const source = read("sources/blogs/tflops-gap-fp4-moe.md");
  includes(source, "author: Konstantin (apsys)");
  includes(source, "This Hugging Face community benchmark");
  excludes(source, "author: apsys (HuggingFace)");
});
test("CUTLASS changelog rows preserve official label dates", () => {
  const source = read("sources/docs/cutlass-changelog-sm100.md");
  for (const phrase of [
    "| 4.6.2 | 2026-08-08 | 2026-08-03 (rendered changelog) |",
    "| 4.6.1 | 2026-07-15 | 2026-07-13 |",
    "no\n4.6.2 section",
  ]) {
    includes(source, phrase);
  }
  for (const phrase of [
    "| 4.6.2 | 2026-08-08 | patch release |",
    "| 4.6.1 | 2026-07-15 | patch release |",
  ]) {
    excludes(source, phrase);
  }
});
test("JAX tutorial uses its rendered author credit", () => {
  const source = read("sources/blogs/jax-pallas-blackwell-matmul.md");
  includes(source, "author: The JAX authors");
  includes(source, "credited by the page to The JAX authors");
  excludes(source, "author: JAX Team (Google)");
});
test("reward hack post credits participant and scopes platform as host", () => {
  const source = read("sources/blogs/gpu-mode-reward-hack.md"),
    contest = read("sources/contests/gpu-mode-nvfp4/problem-4-grouped-gemm.md");
  includes(source, "author: Natalia Kokoromyti\n");
  includes(flat(source), "GPU Mode-hosted post-mortem by contest participant Natalia Kokoromyti");
  includes(source, "describes the author's agent-produced submission");
  includes(
    contest,
    "participant post-mortem by Natalia Kokoromyti, published on GPU Mode's news page",
  );
  includes(
    read("research-contests.md"),
    "participant post-mortem published on GPU Mode's news page",
  );
  const shipped = [
    ...files("sources"),
    ...readdirSync(ROOT).filter((name) => /^research-.*\.md$/.test(name)),
  ];
  const consumers = shipped
    .map((name) => [name, read(name)])
    .filter(([, text]) => text.toLowerCase().includes("post-mortem"));
  assert.ok(consumers.length >= 3);
  const gendered = (text) =>
    flat(text)
      .split(/(?<=[.!?])\s+/)
      .filter(
        (sentence) =>
          sentence.includes("Natalia Kokoromyti") &&
          /\b(?:she|her|hers|herself|he|him|his|himself)\b/i.test(sentence),
      );
  for (const [name, text] of consumers) {
    for (const phrase of [
      "author: Natalia Kokoromyti / GPU Mode",
      "organizer's reward-hacking post-mortem",
      "GPU Mode's post-mortem",
      "GPU Mode's separate reward-hacking post-mortem",
    ]) {
      excludes(text, phrase);
    }
    assert.deepEqual(gendered(text), [], name);
  }
  assert.ok(
    gendered(
      source.replace("the author's agent-produced submission", "her agent-produced submission"),
    ).length,
  );
});
test("size budget matches core manifest and artifact scope", () => {
  const budget = fm("data/phase3-size-budget.yaml"),
    core = fm("data/core-prs.yaml");
  assert.equal(core.total_captured, budget.core_prs_total);
  assert.equal(core.checksum_sha256, budget.core_prs_checksum_sha256);
  assert.equal(budget.artifacts_file_budget, 6000);
  assert.ok(!("pilot_entries" in budget));
  includes(read("scripts/repo-size-check.mjs"), "FILE_COUNT_BUDGET = 6000");
});
test("skill load memo scopes file budget to artifacts", () => {
  const memo = read("data/phase3-skill-load.md");
  includes(memo, "6,000-file budget applies only to files under `artifacts/`");
  includes(memo, "not enforce a whole-working-tree file-count budget");
  excludes(memo, "5002 files of headroom");
});
test("inclusion policy rejects obsolete Triton claim in comments", () => {
  assert.deepEqual(validate.validateInclusionPolicyScalars(), []);
  fixture(({ write }) => {
    write(
      "data/inclusion-policy.yaml",
      "## Triton on SM100 has no direct tcgen05/TMEM access\ntriton:\n  description: Triton 3.6 supports SM100 lowering.\n",
    );
    includes(validate.validateInclusionPolicyScalars().join("\n"), "including comments");
  });
});
test("examples Triton navigation matches current page structure", () => {
  const examples = read("references/examples.md"),
    triton = read("wiki/languages/triton-blackwell.md");
  includes(examples, "its opening paragraph records");
  includes(triton, "earlier blanket statement");
  excludes(examples, "pre-3.6 historical context preserved in a clearly-marked subsection");
  assert.ok(
    !triton
      .split("\n")
      .filter((line) => line.startsWith("#"))
      .some((line) => line.includes("Pre-3.6 historical context")),
  );
});
function yamlBlockAfter(filename, marker) {
  return yaml(read(filename).split(marker)[1].split("```yaml")[1].split("```")[0]);
}
test("extended and condensed performance examples match", () => {
  const extended = yamlBlockAfter("SCHEMA.md", "## Performance Claim Format").performance_claims[0];
  const condensed = yamlBlockAfter("references/schema.md", "### wiki-kernel").performance_claims[0];
  assert.deepEqual(extended, condensed);
  assert.equal(extended.value, 1613);
  assert.equal(extended.source_id, "doc-flash-attention-4");
  includes(extended.shape, "exact maximizing shape not stated");
});
test("source PR schema example matches its named page", () =>
  assert.deepEqual(
    yamlBlockAfter("references/schema.md", "### source-pr"),
    fm("sources/prs/cutlass/PR-2472.md"),
  ));
test("numeric receipt totals are recomputed and synchronized", () => {
  const statuses = read("audit/numeric-claims-ledger.md")
    .split("\n")
    .filter((line) => line.startsWith("| comparison-base |") || line.startsWith("| current |"))
    .map((line) => line.split("|")[4].trim());
  const counts = {};
  for (const status of statuses) {
    counts[status] = (counts[status] || 0) + 1;
  }
  assert.equal(statuses.length, 3812);
  assert.deepEqual(counts, {
    supported: 1121,
    corrected: 2,
    removed: 1946,
    "non-material": 743,
  });
  for (const name of [
    "audit/factual-errors-fixed.md",
    "audit/evidence-ledger.md",
    "audit/validation-results.md",
  ]) {
    includes(read(name), "3,812");
    excludes(read(name), "3,806 current terminal");
  }
});
function splitCommand(command) {
  const words = [];
  let word = "",
    quote = null,
    active = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (
        quote === '"' &&
        char === "\\" &&
        ['"', "\\", "$", "`", "\n"].includes(command[i + 1])
      ) {
        word += command[++i];
      } else {
        word += char;
      }
    } else if (char === "#") {
      break;
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) {
        words.push(word);
        word = "";
        active = false;
      }
    } else {
      word += char === "\\" ? command[++i] : char;
      active = true;
    }
  }
  assert.equal(quote, null, command);
  if (active) {
    words.push(word);
  }
  return words;
}
const docs = () => [
  "README.md",
  "SKILL.md",
  "SCHEMA.md",
  "index.md",
  ...files("references").filter((name) => path.dirname(name) === "references"),
];
test("concrete documented query commands return results", () => {
  const commands = [];
  for (const filename of docs()) {
    for (const line of read(filename).split("\n")) {
      const command = line.trim().replace(/^`+|`+$/g, "");
      if (
        !/^node scripts\/(?:grep_wiki|query|get_page)\.mjs\b/.test(command) ||
        command.includes("<") ||
        command.includes("[--")
      ) {
        continue;
      }
      commands.push([filename, command]);
    }
  }
  assert.ok(commands.length >= 25);
  for (const [filename, command] of commands) {
    const [, ...args] = splitCommand(command);
    const result = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, `${filename}: ${command}\n${output}`);
    assert.ok(output.trim(), command);
    excludes(output, "No matches.");
  }
});

test("skill technique count matches generated index and pages", () => {
  const count = read("queries/by-technique.md")
    .split("\n")
    .filter((line) => line.startsWith("| [")).length;
  assert.equal(files("wiki/techniques").length, count);
  includes(read("SKILL.md"), `— ${count} techniques with architectures`);
});
test("NVFP4 primer row matches retained workload scale contract", () => {
  const row = read("references/primer.md")
    .split("\n")
    .find((line) => line.startsWith("| NVFP4 GEMM |"));
  assert.deepEqual(fm("wiki/kernels/nvfp4-gemm.md").performance_claims, []);
  for (const phrase of [
    "| — |",
    "per-16 FP8 scales",
    "task prose: E4M3FNUZ",
    "reference code: `torch.float8_e4m3fn`",
    "PTX `UE4M3` is distinct",
    "MXFP4's block-32 `UE8M0`",
  ]) {
    includes(row, phrase);
  }
});
test("NVFP4 scale encoding discrepancy is disclosed", () => {
  const names = [
    "wiki/hardware/nvfp4.md",
    "wiki/kernels/nvfp4-gemm.md",
    "wiki/kernels/nvfp4-gemv.md",
    "wiki/techniques/fine-grained-quantization.md",
    "sources/contests/gpu-mode-nvfp4/problem-1-gemv.md",
    "sources/contests/gpu-mode-nvfp4/problem-2-gemm.md",
    "references/primer.md",
  ];
  for (const filename of names) {
    includes(read(filename).toUpperCase(), "E4M3FNUZ");
    includes(read(filename), "float8_e4m3fn");
  }
  const combined = names.map(read).join("\n");
  excludes(combined, "E4M3FNUZ scales (PTX `UE4M3`)");
  excludes(combined, "E4M3 (PTX `UE4M3`)");
});
test("NVFP4 contest input tuple has no global scale operand", () => {
  const hardware = read("wiki/hardware/nvfp4.md"),
    gemm = read("wiki/kernels/nvfp4-gemm.md"),
    gemv = read("wiki/kernels/nvfp4-gemv.md");
  includes(flat(hardware), "do not expose a separate tensor-level scale input");
  includes(flat(gemv), "per-16 FP8 scales, and FP16 output");
  includes(flat(gemv), "no separate tensor-level scale operand");
  includes(flat(gemm), "per-16 FP8 scale tensors");
  excludes(gemv, "tensor-level scaling");
  excludes(gemm, "tensor scales");
  for (const filename of [
    "sources/contests/gpu-mode-nvfp4/problem-1-gemv.md",
    "sources/contests/gpu-mode-nvfp4/problem-2-gemm.md",
  ]) {
    const text = read(filename);
    includes(text, "one FP8 scale per 16 values and FP16 output");
    excludes(text, "tensor-level scale");
    excludes(text, "global scale");
  }
});
test("contest navigation does not promise removed submissions", () => {
  assert.deepEqual(
    files("sources/contests").filter((filename) => "submissions" in fm(filename)),
    [],
  );
  excludes(read("references/primer.md"), "has a `submissions:` block");
  excludes(read("references/examples.md"), "has `submissions:`");
  excludes(read("SCHEMA.md"), "Competition problems and solutions");
  excludes(read("SKILL.md"), "FlashInfer MLSys 2026 submissions");
});
test("skill PR status distribution matches pages", () => {
  const statuses = files("sources/prs").map((filename) => fm(filename).status);
  const merged = statuses.filter((status) => status === "merged").length,
    closed = statuses.filter((status) => status === "closed").length;
  includes(
    read("SKILL.md"),
    `current distribution: ${merged} merged, ${closed} closed without merge`,
  );
  includes(
    read("references/schema.md"),
    `(${merged} of ${statuses.length} are \`merged\`; two are \`closed\` without merge)`,
  );
});
test("shipped artifact mode description matches provenance", () => {
  const modes = new Set(
    files("artifacts", (name) => name === "PROVENANCE.yaml").map(
      (filename) => fm(filename).asset_mode,
    ),
  );
  assert.deepEqual(modes, new Set(["verbatim"]));
  for (const filename of ["README.md", "SKILL.md"]) {
    includes(read(filename), "Verbatim upstream asset bundles");
    excludes(read(filename), "Verbatim/extracted/derived asset bundles");
  }
});
test("GEMV progression points to technique page", () => {
  const examples = read("references/examples.md"),
    technique = read("wiki/techniques/vectorized-loads.md");
  includes(examples, "2000 → 443 → 39 → 27 → 22.392 μs");
  includes(examples, "`wiki/techniques/vectorized-loads.md`");
  for (const value of ["2000", "443", "39", "27", "22.392"]) {
    includes(technique, value);
  }
});
test("flash attention locator and source ordering are evidence bounded", () => {
  const kernel = read("wiki/kernels/flash-attention-4.md"),
    blog = read("sources/blogs/flash-attention-4.md");
  includes(kernel, "#S5 (§5 Empirical Evaluation)");
  excludes(kernel, "Performance Evaluation");
  excludes(kernel, "earlier result set");
  excludes(blog.toLowerCase(), "later paper");
});
test("pipeline percentage receipt names reproducing rows", () => {
  const pipeline = read("wiki/techniques/pipeline-stages.md");
  const receipt = read("audit/numeric-claims-ledger.md")
    .split("\n")
    .find((line) => line.includes("`wiki/techniques/pipeline-stages.md:21` | `35%`"));
  includes(receipt, "v2b and v3 rows (939.61 / 695.43 = 1.35)");
  includes(pipeline, "695.43 TFLOPS");
  includes(pipeline, "939.61 TFLOPS");
  assert.equal(Math.round((939.61 / 695.43 - 1) * 100), 35);
});
test("shipped ID link labels resolve to frontmatter", () => {
  const ids = new Set([...files("sources"), ...files("wiki")].map((filename) => fm(filename).id));
  const prefixes = [
    "pr-",
    "doc-",
    "blog-",
    "contest-",
    "hw-",
    "technique-",
    "kernel-",
    "pattern-",
    "lang-",
    "migration-",
  ];
  const labels = new Set(
    docs()
      .flatMap((filename) =>
        [...read(filename).matchAll(/\[([a-z][a-z0-9-]+)\]\(/g)].map((match) => match[1]),
      )
      .filter((label) => prefixes.some((prefix) => label.startsWith(prefix))),
  );
  assert.deepEqual(
    [...labels].filter((label) => !ids.has(label)),
    [],
  );
});
test("source directory categories match shipped description", () => {
  assert.deepEqual(
    new Set(files("sources/docs").map((filename) => fm(filename).source_category)),
    new Set(["official-doc", "paper"]),
  );
  assert.deepEqual(
    new Set(files("sources/blogs").map((filename) => fm(filename).source_category)),
    new Set(["benchmark-blog", "community-note"]),
  );
  includes(read("SCHEMA.md"), "`source_category: official-doc` or `paper`");
});
test("arxiv sources require paper contract", () => {
  assert.ok(
    validate.arxivSourceClassificationErrors(
      path.join(ROOT, "sources/blogs/example.md"),
      {
        url: "https://arxiv.org/abs/1234.5678",
        source_category: "benchmark-blog",
      },
      "source-blog",
    ).length,
  );
  assert.deepEqual(
    validate.arxivSourceClassificationErrors(
      path.join(ROOT, "sources/docs/example.md"),
      {
        url: "https://arxiv.org/abs/1234.5678",
        source_category: "paper",
      },
      "source-doc",
    ),
    [],
  );
});
test("PTX source uses current exact instruction locators", () => {
  const source = read("sources/docs/nvidia-ptx-isa-sm100.md");
  for (const locator of ["§9.7.17.7", "§9.7.17.10.7", "§9.7.9.26.5.2"]) {
    includes(source, locator);
  }
  for (const stale of ["§9.7.17.8", "§9.7.17.10.1", "§9.7.9.25"]) {
    excludes(source, stale);
  }
  for (const filename of [...files("wiki"), ...files("sources/docs")]) {
    assert.deepEqual(validate.ptxIsaCuratedAnchorErrors(read(filename), filename), []);
  }
  for (const anchor of ["tcgen05-alloc", "cluster-launch-control-instructions"]) {
    assert.ok(
      validate.ptxIsaCuratedAnchorErrors(
        `https://docs.nvidia.com/cuda/parallel-thread-execution/#${anchor}`,
      ).length,
    );
  }
});
test("Blackwell relevance promise matches wiki only scope and known corpus violation", () => {
  const hopper = validate.HOPPER_ARCHITECTURES,
    blackwell = validate.BLACKWELL_ARCHITECTURES;
  const wiki = [],
    sources = [];
  for (const directory of ["wiki", "sources"]) {
    for (const filename of files(directory)) {
      const page = fm(filename),
        architectures = page.architectures || [];
      if (
        architectures.some((arch) => hopper.has(arch)) &&
        !architectures.some((arch) => blackwell.has(arch)) &&
        (directory === "wiki" || !("blackwell_relevance" in page))
      ) {
        (directory === "wiki" ? wiki : sources).push([filename, page]);
      }
    }
  }
  assert.ok(wiki.length);
  assert.ok(sources.length);
  const invalid = wiki.filter(([, page]) => !("blackwell_relevance" in page));
  assert.deepEqual(
    invalid.map(([filename]) => filename),
    ["wiki/patterns/coalesced-warp-mapping-memory-bound.md"],
  );
  for (const [filename, page] of invalid) {
    assert.equal(validate.blackwellRelevanceErrors(page, "wiki-pattern", filename).length, 1);
  }
  for (const arch of blackwell) {
    assert.deepEqual(
      validate.blackwellRelevanceErrors(
        {
          architectures: ["sm90", arch],
        },
        "wiki-hardware",
      ),
      [],
    );
  }
  for (const arch of hopper) {
    assert.ok(
      validate.blackwellRelevanceErrors(
        {
          architectures: [arch],
        },
        "wiki-pattern",
      ).length,
    );
  }
  assert.deepEqual(
    validate.blackwellRelevanceErrors(
      {
        architectures: [...hopper].sort(),
      },
      "source-doc",
    ),
    [],
  );
  for (const filename of ["README.md", "SKILL.md", "SCHEMA.md", "references/schema.md"]) {
    for (const phrase of ["wiki pages", "source pages", "exempt"]) {
      includes(read(filename).toLowerCase(), phrase);
    }
  }
});
test("merge SHA exists only for merged PRs and is full length", async () => {
  const statuses = [];
  for (const filename of files("sources/prs")) {
    const page = fm(filename);
    statuses.push(page.status);
    assert.deepEqual(validate.mergeShaContractErrors(page, filename), []);
  }
  assert.equal(statuses.filter((status) => status === "merged").length, 942);
  assert.equal(statuses.filter((status) => status === "closed").length, 2);
  for (const page of [
    {
      status: "merged",
    },
    {
      status: "merged",
      merge_sha: "unknown",
    },
    {
      status: "closed",
      merge_sha: "a".repeat(40),
    },
  ]) {
    assert.ok(validate.mergeShaContractErrors(page).length);
  }
  const generator = await import("../scripts/generate-pr-pages.mjs");
  const payload = {
    number: 1,
    title: "Closed CUDA implementation",
    user: {
      login: "author",
    },
    created_at: "2026-01-02T03:04:05Z",
    html_url: "https://github.com/example/project/pull/1",
    state: "closed",
    merged: false,
    merge_commit_sha: "ephemeral-test-merge",
    body: "Upstream body.",
  };
  const changed = [
    {
      filename: "csrc/kernel.cu",
      status: "added",
      patch: "+__global__ void kernel() {}",
    },
  ];
  const rendered = generator.generatePage(
    "example/project",
    payload,
    changed,
    "ignored",
    "2026-08-18",
  );
  const generated = yaml(rendered.split("---")[1]);
  assert.equal(generated.status, "closed");
  assert.ok(!("merge_sha" in generated));
  Object.assign(payload, {
    merged: true,
    merge_commit_sha: null,
  });
  assert.throws(
    () => generator.generatePage("example/project", payload, changed, "ignored", "2026-08-18"),
    /has no merge_commit_sha/,
  );
});
test("known invalid pattern retains all ten validator errors", () => {
  const filename = "wiki/patterns/coalesced-warp-mapping-memory-bound.md";
  const sourceIds = new Set(files("sources").map((filename) => fm(filename).id));
  const errors = validate.validateFile(
    path.join(ROOT, filename),
    fm("data/schemas.yaml"),
    fm("data/tags.yaml"),
    sourceIds,
    validate.loadCodeLangs(),
  );
  assert.equal(errors.length, 10, errors.join("\n"));
  for (const phrase of [
    "missing required field 'symptoms'",
    "missing required field 'candidate_techniques'",
    "missing required field 'related'",
    "must start with 'pattern-'",
    "'coalescing' is not a valid tags",
    "'memory-bound' is not a valid tags",
    "'request-amplification' is not a valid tags",
    "page targets only Hopper",
    "references unknown source id 'contract:523e38b2f233'",
    "requires non-empty 'evidence_basis'",
  ]) {
    includes(errors.join("\n"), phrase);
  }
});
