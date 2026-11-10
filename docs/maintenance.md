# Corpus maintenance

The repository root is the kernel-wiki skill directory. Query and maintenance
commands use Node.js >= 22; offline operations need no Python or package
installation. GitHub capture and live verification additionally require `gh`
and network access. Contributor lint/format tools are installed with `npm ci`.

## File ownership

| Location | Purpose | Format |
| --- | --- | --- |
| `data/` | Schemas, vocabularies, inclusion rules, version registries, refresh metadata, budgets, generated manifests | JSON |
| `data/evidence/` | Current PR architecture and capped-file evidence receipts | JSON |
| `candidates/` | Reviewed PR candidate ledgers, one per upstream repository | JSON |
| `tests/fixtures/` | PR policy/page cases and valid/invalid ledger inputs | JSON |
| `sources/`, `wiki/`, `queries/` | Source summaries, synthesized knowledge, generated navigation | Markdown with page frontmatter where applicable |
| `references/` | Primers, schema examples, topic research, evidence explanations | Markdown |
| `docs/` | Current developer instructions and operating contracts | Markdown |
| `artifacts/` | Pinned upstream code, patches, manifests, and provenance | Original captured formats |
| `.dev/` | Specs, plans, review results, measurements, retired development records | Local, gitignored process state |

The hygiene check rejects unowned metadata names, nested process-report trees,
and symlinks in machine-data paths. Register new input filenames in
`check-hygiene.mjs` together with their reader, writer, and behavior tests.
Candidate filenames identify upstream repository slugs; reusable test inputs
use the declared domain fixture names.

`SANITIZED.yaml` remains at the root because pi-kernel-expert consumes and
updates that exact manifest. YAML page frontmatter and upstream
`PROVENANCE.yaml` / `MANIFEST.yaml` files retain their existing contracts.
The YAML adapter preserves archived scalar semantics, including SHA-like
strings. First-party metadata readers and writers use strict JSON.

Dates and timestamps in JSON are strings. The JSON adapter preserves unsafe
integer tokens as BigInt and keeps floating-point values numeric across writes;
invalid budget syntax or field types fail instead of disabling the size gate.

## Commands

```bash
npm test
npm run lint
npm run format:check
npm run check:hygiene
npm run validate
npm run generate:indices
npm run generate:core
npm run check:core
npm run check:dod
npm run check:size
npm run check:freshness
npm run check:blogs
```

All corpus commands are direct `node scripts/<name>.mjs` invocations. The
existing `query.mjs`, `get_page.mjs`, `grep_wiki.mjs`, and `repo_status.mjs`
entry points remain stable for pi-kernel-expert.

Update candidate ledgers with `refresh-candidate-ledger.mjs --cutoff YYYY-MM-DD`,
generate missing pages with `generate-pr-pages.mjs --all`, then regenerate
indices/manifests and validate. Dry-run asset capture and contest collection
perform no writes. Freshness and structural checks stay offline.

The three generated manifest files use `checksum_format: json-utf8-v1` in the
core manifest. The checksum hashes the selected PR list serialized with two
spaces and a final newline. Inclusion membership is independent of serialization.
Evidence receipts retain captured rows, source hashes, and behavior-case hashes;
regression checks must pass before updating an implementation binding.

Install the optional Git hook with `node scripts/install-precommit-hook.mjs`.
It runs validation, repository size, and asset contract checks. The installer
protects unrelated existing hooks and supports Git worktrees.

## Current corpus findings

The validator currently reports 29 inherited data problems: 19 provenance
entries point to files explicitly removed in `SANITIZED.yaml`; ten findings
concern the schema, vocabulary, attribution, and evidence metadata of
`wiki/patterns/coalesced-warp-mapping-memory-bound.md`. The command exits 1.
These are data corrections to make, not exceptions to hide in the validator.

Live upstream checks are separate from structural validation. Unit tests use
controlled upstream responses; a successful test suite does not claim that
all remote content was re-fetched. Historical review reports remain in Git
history; local copies and current work evidence are kept under `.dev/audit/`.

See [CONSTRAINTS.md](CONSTRAINTS.md) for the quality floor and
[code-style.md](code-style.md) for JavaScript conventions.
