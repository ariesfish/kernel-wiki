# JavaScript corpus maintenance migration

## Scope and runtime

The skill root is the repository root. Queries already ran on Node.js; this
migration moves the remaining ingestion, generation, validation, and audit
commands to JavaScript ESM. Node.js >= 22 and the committed YAML parser are
sufficient for offline operations. Upstream retrieval additionally uses `gh`
and network access. No Python executable, virtual environment, `uv`, or
package installation is part of the maintenance workflow.

Python, CUDA, and C++ files under `artifacts/` are archived upstream kernel
code. They remain byte-for-byte evidence, not repository executables.
Historical provenance and audit documents may name the original Python
commands; those records describe how existing captures were produced.

Most maintenance logic uses files, YAML, regular expressions, hashes, and
GitHub requests, all available through Node built-ins and the vendored parser.
The Python-specific dependency was tokenization for recognizing executable
DSL constructs without accepting comments or strings as evidence. The
JavaScript policy supplies a narrow lexer for that task and retains the
original evidence-pattern digests.

## Module boundaries

| Area | Entry points and responsibility |
| --- | --- |
| Queries | `query.mjs`, `get_page.mjs`, `grep_wiki.mjs`, `repo_status.mjs`; existing CLI and page IDs remain the consumer contract |
| PR policy | `pr_policy.mjs`; shared scope, architecture evidence, language inference, generated-body contracts, and evidence hashing |
| Ingestion | `refresh_candidate_ledger.mjs`, `generate-pr-pages.mjs`, `fetch_pr_diff.mjs`; candidate decisions, PR pages, pinned asset capture |
| Generated navigation | `generate-indices.mjs`; seven cross-reference indices |
| Core manifests | `compute_core_prs.mjs`, `verify_core_prs.mjs`; deterministic core PR and DSL universe derivation |
| Extraction | `extract_blog_code.mjs`, `collect_contest_code.mjs`; source bundles and manifests |
| Offline checks | `validate.mjs`, `check_dod_fixtures.mjs`, `check_version_freshness.mjs`, `repo_size_check.mjs` |
| Live evidence | `verify_verbatim.mjs`, `verify_pr_architecture_upstream.mjs`; remote SHA/content verification |
| Shared infrastructure | `_root.mjs`, `_corpus.mjs`, `_yaml.mjs`, `_architectures.mjs`, `_aliases.mjs`; root discovery, corpus reads, YAML and controlled vocabulary |

Maintenance modules expose functions for behavior tests and only execute their
CLI when invoked directly. Script paths change from `.py` to `.mjs`; names and
flags retain their existing meanings. `BLACKWELL_WIKI_ROOT` relocates the corpus.

## Commands

```bash
npm test
npm run validate
npm run generate:indices
npm run generate:core
npm run check:core
npm run check:dod
npm run check:size
npm run check:freshness
npm run check:blogs
```

Every npm command is a direct `node scripts/<name>.mjs` invocation and also
works without an install step. To install the optional Git hook:

```bash
node scripts/install_precommit_hook.mjs
```

The installer supports Git worktrees, preserves an existing unrelated hook
unless `--force` is specified, and installs Node.js checks. It runs validation
first, followed by size and DoD checks when their policy files exist.

## Baseline recorded before migration

- Existing Node suite: 20 tests passed.
- Python suite: 154 tests ran, with one failure and five errors. Five tests
  still read the removed `CLAUDE.md` instead of `SCHEMA.md`; the failure is a
  Hopper-only page without the promised `blackwell_relevance` metadata.
- Python validator: 1,042 pages, 989 source IDs, 37 bundles, 14 candidate
  ledgers; 29 existing errors. Nineteen are missing assets explicitly removed
  in `SANITIZED.yaml`. Ten concern the existing
  `wiki/patterns/coalesced-warp-mapping-memory-bound.md` page, including schema,
  controlled vocabulary, source attribution, and evidence metadata.
- Definition-of-Done check: three active and two retired fixtures passed.
- Frozen SHA-256 contracts: device-code pattern
  `07f6f8bdf90ee2dcae5100acad1b938dd84560d1886510c9fc1a45a2db53681d`;
  Python-DSL pattern
  `782e8e05929de589d3e20db1a89bc732c34d9728c1654700e0c4fbce55d17877`.

Existing corpus errors remain visible. Runtime migration does not certify
source claims or recover removed restricted files. Live checks require a
successful GitHub session before they can certify remote content.

## Integration boundary with pi-kernel-expert

`pi-kernel-expert` already invokes the query `.mjs` commands, so their names,
page IDs, and output formats remain stable. Its candidate publishing guidance
still mentions `uv run scripts/generate-indices.py`; that consuming repository
must switch the guidance to `node scripts/generate-indices.mjs` with its next
pin bump. Its pin, release notes, and notices belong to a separate change in
that repository.

## Compatibility details

The YAML entry point keeps query parsing at its existing YAML 1.2 defaults.
Maintenance uses shared compatibility parsing and serialization: short SHAs
such as `0e026982` stay strings; exponent floats remain numeric when written;
large integers remain exact; timestamp spelling preserves timezone,
microseconds, and the distinction between a date and a midnight timestamp.
These contracts have unit tests and a refresh-without-new-rows regression test.

Three generated core/universe manifests now identify their `.mjs` generator.
The universe files also use the Node emitter's line wrapping. Their parsed
contents match Python output, and the core PR checksum remains
`cde1aab41b706ba9b050d63b61a5d6a62c9c3c547d56caddd535b652ddfb7c59`.

The two frozen PR audit receipts now bind `scripts/pr_policy.mjs`. Each retains
the original Python policy SHA and identifies the 388-case parity fixture and
its hash. The cap-correction receipt link was updated accordingly. The six
cap-correction rows and 944 architecture rows remain unchanged; this migration
does not claim to have recaptured live upstream evidence.

## Verification results

- **252 Node tests passed**, with zero failures or skips, in a temporary copy
  without `node_modules`, Python tooling, or an install step. Tests ran with
  Node v24.21.0 from outside that copy. The declared minimum remains Node 22;
  a separate Node 22 executable was not available on this machine.
- **388 frozen policy calls** preserve the original Python results, including
  both pattern digests. **Eight PR generation cases** preserve the original
  frontmatter and body, including large file counts, CRLF, Unicode, and
  artifact references.
- **Seven generated indices** match Python output byte-for-byte for the same
  1,042-page corpus. Existing checked-in indices were preserved.
- **Three core/universe manifests** preserve their parsed content and the
  110-PR checksum. `verify_core_prs.mjs` passes after regeneration.
- **1,457 corpus, query, and artifact files** retain their pre-migration
  SHA-256 values. This includes all 403 artifact files.
- **Validator diagnostics match exactly:** the same 29 pre-existing errors,
  with no added or removed errors. `validate.mjs` correctly exits 1; this
  repository does not currently meet the zero-error corpus quality gate.
- **DoD, blog extraction checks, and repository size checks pass.** The
  reviewable tree remains below its 25 MiB ceiling.
- **Node-only PATH checks pass** for offline maintenance commands and dry-run
  asset collection. An offline freshness test traps network and subprocess
  APIs. PR capture dry-run output matches the Python baseline.
- **IDE diagnostics are clear.** Git diff whitespace checks pass.
- **Independent adversarial review** ran three bounded passes and identified
  float emission, timestamp grammar/precision/offset, and integer write-back
  issues in the compatibility layer. All findings were fixed and covered by
  regression tests, including integral-valued doubles outside the safe integer
  range and timestamps with one-minute offsets or years below 100.

Live GitHub evidence checks were exercised with injected responses and failure
cases. A full network re-verification of archived upstream content was not run.
Local baseline logs and comparison evidence are under
`.dev/js-migration/evidence/` (gitignored process records).
