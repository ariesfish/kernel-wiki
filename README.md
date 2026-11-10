# KernelWiki — Blackwell & Hopper Kernel Optimization Knowledge Base
> [!IMPORTANT]
> **This is `kernel-wiki`, a maintained copy of
> [KernelWiki](https://github.com/mit-han-lab/KernelWiki) (MIT, hanlab).** This copy
> uses the skill name `kernel-wiki` so Agent Skills runtimes load it without a warning;
> removes the 19 files marked `LicenseRef-NvidiaProprietary` at the source (see
> `SANITIZED.yaml`); and runs all query and maintenance tools on Node.js.
> [`pi-kernel-expert`](https://github.com/ariesfish/pi-kernel-expert) pins this copy.
>
> Page ids are frozen: `migration-wgmma-to-tcgen05` here is the same id upstream, because ids are
> the citation contract. Update the corpus by adding pages and running
> `node scripts/generate-indices.mjs` plus the quality checks in `scripts/`; never renumber an id.

> **Evidence boundaries:** the audited upstream PR corpus closes at 2026-05-20;
> documentation, releases, and leaderboard snapshots were verified through
> 2026-08-18 UTC.

A structured knowledge base of NVIDIA Blackwell (SM100, B200) and Hopper (SM90, H100) GPU kernel optimization, packaged as a standard **Agent Skill**: `SKILL.md` at the repository root, portable frontmatter, supporting scripts alongside. The repository root **is** the skill directory.

## Install

Any Agent Skills runtime that reads a directory containing `SKILL.md` can use it. Place the clone where that runtime looks:

| Runtime | Location |
|---|---|
| pi (via `pi-kernel-expert`) | fetched automatically into the pi agent cache at a pinned revision — no manual step |
| pi (manual) | `~/.agents/skills/kernel-wiki` or `.agents/skills/kernel-wiki` |
| Claude Code | `~/.claude/skills/kernel-wiki` |
| anything else | wherever the runtime discovers skills |

```bash
git clone git@github.com:ariesfish/kernel-wiki.git <that-location>
```

The query tools are Node.js (>= 22) and resolve the corpus root to their own directory, so no environment variable, `npm install`, or Python interpreter is required. The YAML parser is vendored as a single ESM file under `scripts/vendor/`.

All query and maintenance tools run on Node.js (>= 22), use the committed YAML parser, and need no `npm install` or Python environment. Commands that retrieve upstream evidence also need `gh` with GitHub access.

```bash
node scripts/validate.mjs
```

Smoke test:

```bash
cd <the skill directory>
node scripts/query.mjs --tag nvfp4 --type kernel --compact
node scripts/get_page.mjs kernel-flash-attention-4 --frontmatter-only
```

Optional override for relocating the scripts:

```bash
export BLACKWELL_WIKI_ROOT=/path/to/KernelWiki
```

> **Migration note:** all repository tooling now uses `node scripts/*.mjs`.
> Consumers that invoke maintenance scripts must update those commands when
> bumping their corpus pin. Python files under `artifacts/` are preserved
> upstream kernel evidence; repository tooling does not execute them.

## What's Here

- Source PR pages, synthesized wiki pages, blog/doc/contest summaries, candidate ledgers, query indices, and artifact bundles.
- Verbatim upstream asset bundles under `artifacts/` (PR patches and complete kernel files or excerpts) — pinned to upstream SHAs via `PROVENANCE.yaml`.
- Auto-generated cross-reference indices — [by architecture](queries/by-architecture.md) / problem / technique / hardware feature / repo / kernel type / language.
- Reviewed candidate ledgers with include/defer/exclude decisions.
- **Hybrid version-claim registry** ([`data/version-claims.yaml`](data/version-claims.yaml)) — per-page `version_sensitive: <id>` pointers + central registry, validated for bidirectional consistency
- Run `node scripts/repo_status.mjs` for current corpus counts.

## Query Tools

All tools run from the skill root, no env var needed.

| Tool | Purpose |
|---|---|
| `scripts/query.mjs` | Unified search across source and wiki pages (keywords + filters + alias-aware) |
| `scripts/get_page.mjs` | Fetch any page by `id` or path; `--follow-sources` expands cited sources |
| `scripts/grep_wiki.mjs` | Regex text search across wiki bodies and PR pages |
| `scripts/repo_status.mjs` | Print current corpus counts |

Examples:

```bash
node scripts/query.mjs "ping-pong attention" --limit 5
node scripts/query.mjs --tag UMMA --type hardware --compact          # alias → tcgen05
node scripts/query.mjs --architecture B200 --type kernel             # alias → sm100
node scripts/get_page.mjs kernel-flash-attention-4 --follow-sources
node scripts/grep_wiki.mjs "tcgen05" --only wiki
```

## Companion Docs

- [`SKILL.md`](SKILL.md) — Skill entry point: when to engage, 5 navigation paths, output contract.
- [`references/primer.md`](references/primer.md) — Topic map: hardware features, techniques, kernels, symptoms → canonical page IDs.
- [`references/schema.md`](references/schema.md) — Frontmatter schema, confidence rules, reproducibility ladder, controlled vocabulary, canonical aliases.
- [`references/examples.md`](references/examples.md) — 10 worked query patterns (user question → command sequence → synthesis).
- [`SCHEMA.md`](SCHEMA.md) — Extended schema + navigation reference (tool-agnostic).
- [`index.md`](index.md) — Human-facing curated top-level index.

## Architecture

Three layers (inspired by [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)):

1. **`sources/`** — Raw data. Immutable summaries of PRs, blogs, docs, contests.
2. **`wiki/`** — Synthesized knowledge pages. Cross-referenced by `id`. All have YAML frontmatter.
3. **`queries/`** — Auto-generated cross-reference indices. Do not edit manually; regenerate via `node scripts/generate-indices.mjs`.

Supporting files:
- `data/schemas.yaml` — Required/optional fields per page type
- `data/tags.yaml` — Controlled vocabulary (80+ tags)
- `data/aliases.yaml` — Canonical → synonym mappings
- `data/architectures.json` — Architecture hierarchy and documented product mappings shared by queries and maintenance tools
- `data/version-claims.yaml` — Central registry for version-sensitive claims (DEC-1 hybrid)
- `data/tool-versions.yaml` — Snapshot of tracked tool releases (Triton, CUTLASS, CUDA, PTX, …)
- `data/refresh-cutoff.yaml` — Internal refresh-round metadata used by validators
- `candidates/` — Reviewed PR candidate ledgers (per repo)
- `artifacts/` — Verbatim upstream asset bundles, each with `PROVENANCE.yaml`

## Maintenance Tooling

| Script | Purpose |
|---|---|
| `scripts/validate.mjs` | Validate frontmatter, schemas, links, evidence receipts, ledgers, and artifact bundles |
| `scripts/generate-indices.mjs` | Regenerate `queries/*.md` from frontmatter |
| `scripts/generate-pr-pages.mjs` | Generate source PR pages from candidate ledgers and upstream evidence |
| `scripts/refresh-candidate-ledger.mjs` | Refresh candidate decisions from GitHub |
| `scripts/compute-core-prs.mjs` | Derive core PR and DSL universe manifests |
| `scripts/fetch-pr-diff.mjs` | Capture upstream PR diffs and pinned source files |
| `scripts/extract-blog-code.mjs` | Extract and check blog code bundles |
| `scripts/collect-contest-code.mjs` | Collect contest submission bundles |
| `scripts/check-version-freshness.mjs` | Check local version and ledger freshness without network access |

```bash
npm test
npm run validate
npm run generate:indices
npm run check:dod
npm run check:core
npm run check:size
```

These commands also work directly with `node scripts/<name>.mjs` from a fresh clone. `npm install` is needed only to rebuild the vendored YAML bundle. Upstream verification commands use `gh` and require network access. See [the JavaScript migration notes](docs/javascript-migration.md) for module boundaries, compatibility, and verification evidence.

## Quality Gates

- `scripts/validate.mjs` reports 0 validation errors
- `scripts/verify-verbatim.mjs` verifies upstream-pinned assets
- `scripts/check-dod-fixtures.mjs` verifies every active Definition-of-Done asset contract and audits retired fixture tombstones
- `scripts/verify-pr-architecture-upstream.mjs` re-derives a deterministic high-risk PR sample from live paginated GitHub evidence
- `scripts/verify-core-prs.mjs` verifies generated PR manifests
- `scripts/repo-size-check.mjs` enforces the repository size budget
- 0 broken links across all internal references
- All `verified` wiki pages have official-doc + upstream-code evidence (enforced by `evidence_basis` field)
- All technique/kernel/language pages have compilable code snippets (`reproducibility >= snippet`)
- All Hopper-only wiki pages explain their `blackwell_relevance`; source pages preserve upstream evidence and are exempt
- Version-sensitive claims (currently Triton 3.6) carry `version_sensitive: <id>` pointers resolving to the central registry

## Scope Rules

- **Blackwell-first** — SM100 content is primary. Hopper-only wiki pages require an explicit `blackwell_relevance` field; source pages are exempt.
- **Kernel-only** — No distributed-system topics (DeepEP, DualPipe, EPLB are out of scope).
- **English canonical** — All content in English.
- **First-class DSLs** — CuTe DSL, CUDA C++, PTX, Triton. TileLang / cuTile / JAX-Pallas mentioned but no dedicated guides.

## Repository Layout

```
kernel-wiki/                            (= the skill directory the runtime loads)
├── SKILL.md                           # Skill entry point
├── README.md                          # This file
├── SCHEMA.md                          # Extended navigation + schema reference
├── index.md                           # Curated top-level index
├── package.json                       # Node tooling, maintenance commands, and tests
│
├── scripts/                           # Query and maintenance tooling (JavaScript)
│   ├── query.mjs                      # Unified search
│   ├── get_page.mjs                   # Page fetcher
│   ├── grep_wiki.mjs                  # Regex search
│   ├── repo_status.mjs                # Corpus counts
│   ├── lib/                           # Shared modules
│   │   ├── root.mjs                   # Corpus root resolver
│   │   ├── corpus.mjs                 # Page and artifact discovery
│   │   ├── architectures.mjs          # Architecture matcher
│   │   ├── aliases.mjs                # Alias expansion
│   │   ├── yaml.mjs                   # YAML compatibility adapter
│   │   └── pr-policy.mjs              # PR evidence policy
│   ├── vendor/yaml.mjs                # Committed YAML bundle
│   ├── validate.mjs                   # Schema and evidence validator
│   ├── generate-indices.mjs           # Query-index generator
│   └── generate-pr-pages.mjs          # Batch PR page generator
│
├── tests/                             # Node.js *.test.mjs files
│   ├── helpers/                       # Test fixture utilities
│   └── fixtures/                      # Frozen data and regression inputs
│
├── references/                        # Skill knowledge layer
│   ├── primer.md                      # Topic map
│   ├── schema.md                      # Condensed schema reference
│   └── examples.md                    # 10 worked query patterns
│
├── data/                              # Schema + vocabulary
│   ├── schemas.yaml
│   ├── tags.yaml
│   └── aliases.yaml
│
├── candidates/                        # Reviewed PR ledgers (ingestion source of truth)
│   ├── cutlass.yaml
│   ├── sglang.yaml
│   ├── vllm.yaml
│   ├── flashinfer.yaml
│   ├── pytorch.yaml
│   └── deepgemm.yaml
│
├── sources/                           # Layer 1: raw data
│   ├── prs/{repo}/PR-{N}.md
│   ├── contests/{contest}/
│   ├── docs/
│   └── blogs/
│
├── wiki/                              # Layer 2: synthesized knowledge
│   ├── hardware/
│   ├── techniques/
│   ├── kernels/
│   ├── patterns/
│   ├── languages/
│   └── migration/
│
└── queries/                           # Layer 3: auto-generated indices
    ├── by-problem.md
    ├── by-architecture.md
    ├── by-technique.md
    ├── by-hardware-feature.md
    ├── by-repo.md
    ├── by-kernel-type.md
    └── by-language.md
```

## License

Summaries and wiki syntheses in this repository are derivative works citing upstream PRs, blogs, and docs. The tooling (`scripts/`, `references/`, `data/`) is MIT-style; see individual files for any exceptions.
