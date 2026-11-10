# KernelWiki — Blackwell & Hopper Kernel Optimization Knowledge Base

A curated knowledge base for NVIDIA Blackwell (SM100, B200) and Hopper
(SM90, H100) GPU kernel optimization, packaged as an **Agent Skill**. It connects
implementation evidence from upstream PRs, official documentation, papers,
blogs, and contests to reusable explanations of kernels and optimization
techniques.

This is a maintained copy of [mit-han-lab/KernelWiki](https://github.com/mit-han-lab/KernelWiki),
used by [pi-kernel-expert](https://github.com/ariesfish/pi-kernel-expert) at a pinned
revision. The skill is named `kernel-wiki`; all query and maintenance tools run
on Node.js. Nineteen upstream files marked `LicenseRef-NvidiaProprietary` are
removed and recorded in [SANITIZED.yaml](SANITIZED.yaml). Page IDs remain stable
so existing citations continue to resolve.

> **Evidence boundaries:** the audited upstream PR corpus closes at 2026-05-20;
> documentation, releases, and leaderboard snapshots were verified through
> 2026-08-18 UTC. Updating the tooling does not advance those evidence dates.

## How the wiki is collected and generated

The corpus separates source evidence, authored synthesis, and generated
navigation. Collection scripts make evidence inspectable; maintainers decide
which conclusions that evidence supports.

1. **Discover and classify candidate PRs.** `refresh-candidate-ledger.mjs`
   searches the tracked repositories using their recorded keywords and a cutoff
   date. New hits are classified from PR descriptions and changed-file evidence
   using the shared scope policy. Each candidate ledger records `include`,
   `exclude`, or `defer`; unavailable evidence remains deferred. Refreshing
   preserves existing curator decisions.
2. **Generate source pages and collect assets.** `generate-pr-pages.mjs`
   creates missing source PR pages for included candidates. It records upstream
   attribution, architecture evidence, language and technique metadata, and an
   excerpt of the upstream description. A core-PR manifest is derived from wiki
   citations, contest references, DSL inclusion rules, and explicit overrides.
   `fetch-pr-diff.mjs` uses that manifest to capture pinned diffs and source files.
   **Verbatim upstream asset bundles** retain their hashes, revisions, and
   provenance. Blog and contest extraction have separate tools and record the
   actual origin and extraction mode.
3. **Write the wiki synthesis.** Maintainers curate documentation, paper,
   blog, and contest summaries, then connect source pages to explanations of
   hardware features, techniques, kernels, symptoms, languages, and migrations.
   These wiki pages carry source IDs, confidence levels, code snippets, and
   evidence for performance claims. Scripts do not automatically turn a PR
   description into an optimization recommendation.
4. **Generate navigation and verify consistency.** `generate-indices.mjs`
   builds seven cross-reference indices from page frontmatter. The query tools
   read the same corpus and controlled vocabulary. Validation checks schemas,
   references, candidate decisions, version claims, architecture receipts,
   provenance, asset hashes, and size limits. Separate live checks compare
   retained evidence with upstream GitHub content.

The scope is Blackwell-first and kernel-focused. Hopper-only wiki pages require
`blackwell_relevance`; source pages preserve upstream evidence and are exempt.
Distributed-system topics such as DeepEP, EPLB, and DualPipe are excluded.

## Refreshing the corpus

A typical maintenance sequence is:

```bash
node scripts/refresh-candidate-ledger.mjs --cutoff YYYY-MM-DD --repos cutlass,sglang
node scripts/generate-pr-pages.mjs --all
# Review source evidence and author or update the relevant wiki pages.
node scripts/compute-core-prs.mjs
node scripts/fetch-pr-diff.mjs --all
node scripts/generate-indices.mjs
node scripts/validate.mjs
```

GitHub collection requires authenticated `gh` and network access. Local queries,
index generation, and structural checks need only Node.js >= 22; no Python or
package installation is required. Re-running page generation skips existing PR
pages, so a source refresh must also review existing pages and their evidence.
Keep page IDs stable when updating content.

The quality checks include:

```bash
npm test
npm run check:hygiene
npm run check:core
npm run check:dod
npm run check:size
npm run check:freshness
npm run check:blogs
```

The validator currently reports 29 inherited corpus findings; their causes and
the distinction between local and live verification are documented in
[maintenance.md](docs/maintenance.md). Contributors use `npm ci` for linting,
formatting, and rebuilding the vendored YAML parser. See
[CONSTRAINTS.md](docs/CONSTRAINTS.md) and [code-style.md](docs/code-style.md).

## Install and query

The repository root is the skill directory: any Agent Skills runtime that reads
`SKILL.md` can load it. pi-kernel-expert fetches its pinned copy automatically.
For a manual installation, clone into the runtime's skill location, for example
`~/.agents/skills/kernel-wiki` for pi or `~/.claude/skills/kernel-wiki` for Claude Code.

```bash
git clone git@github.com:ariesfish/kernel-wiki.git <skill-directory>
cd <skill-directory>
node scripts/query.mjs --tag nvfp4 --type kernel --compact
node scripts/query.mjs --architecture B200 --type kernel
node scripts/get_page.mjs kernel-flash-attention-4 --follow-sources
node scripts/grep_wiki.mjs "tcgen05" --only wiki
node scripts/repo_status.mjs
```

Commands resolve the corpus relative to their own location. Set
`BLACKWELL_WIKI_ROOT` only when explicitly using a different corpus root.

Start with [the topic primer](references/primer.md),
[query examples](references/examples.md), or [the curated index](index.md).
[SKILL.md](SKILL.md) defines the citation and output contract;
[the schema reference](references/schema.md) describes page metadata and
confidence rules. The generated [architecture index](queries/by-architecture.md)
provides exact-target, family, and unknown-evidence views.

## License

Summaries and wiki syntheses cite their upstream PRs, documentation, papers,
and blogs. Original KernelWiki material is MIT licensed; verbatim artifacts
retain their upstream terms and per-bundle provenance. See [LICENSE](LICENSE).
