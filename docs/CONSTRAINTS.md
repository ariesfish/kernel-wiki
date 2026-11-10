# Repository constraints

These are the repository's quality requirements. Changes to a limit or evidence
contract require an explicit decision; cleanup must preserve the requirements.

## Verification

- ESLint: zero errors and zero warnings. Prettier checks pass.
- All current behavior tests pass with zero skips. Retire a test only when its
  entire subject is a deliberately removed feature; record the rationale in
  `.dev/audit/` and keep the remaining behavior assertions.
- Preserve at least 388 PR policy cases and eight PR page-generation cases.
- Offline tools and the behavior suite run without installed runtime packages
  or Python. Freshness checks perform no network or subprocess operations.
- Generated core manifests reproduce committed JSON bytes. Their checksum is
  SHA-256 over the canonical JSON encoding of the selected PR list.
- Validation keeps schema, source, scope, version, file-containment, size,
  provenance, and hash checks. The existing 29 corpus findings documented in
  `maintenance.md` must remain visible until their underlying data is fixed.

## Data and process records

- `data/`, `candidates/`, and `tests/fixtures/` contain consumed JSON files only.
- Machine evidence belongs in `data/evidence/`. Human knowledge uses Markdown
  under `sources/`, `wiki/`, or `references/`; developer guidance uses `docs/`.
- Specs, plans, review rounds, coverage reports, stage snapshots, and migration
  journals belong under `.dev/`. Runtime tools must not read them.
- Published files have domain names. No `python-*` fixtures, `phase*` process
  files, root `audit/` tree, or obsolete plan-supersession dependency.
- Upstream assets retain their pinned formats and bytes. `SANITIZED.yaml` is
  the compatibility manifest read and written by pi-kernel-expert.

## Resource limits

- Reviewable working tree: at most **25 MiB**.
- Artifact inventory: at most **6,000 files**; this is not a whole-tree count.
- Captured upstream files: **1 MiB per file**, **5 MiB per bundle**, with
  explicit truncation metadata when capture cannot include complete bytes.
- Preserve independent active/retired asset contract rosters and immutable
  upstream hashes. Moving a record does not waive its evidence requirements.
