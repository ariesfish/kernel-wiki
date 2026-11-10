# Candidate ledgers

Each JSON file under `candidates/` records the reviewed include, exclude, or
defer decision for PRs in one upstream repository. It is active intake data,
not a development log.

Required ledger fields and row contracts are declared in `data/schemas.json`
and enforced by `validate.mjs`. Summary totals must match row decisions.
Refreshes preserve existing curator decisions and only classify new hits from
authoritative PR evidence. Missing evidence remains `defer`.

```bash
node scripts/refresh-candidate-ledger.mjs --cutoff YYYY-MM-DD --repos cutlass,sglang
node scripts/generate-pr-pages.mjs --all
node scripts/validate.mjs
```

Candidate refresh can perform network reads. Use `--dry-run` to inspect
results without writing ledgers or refresh metadata. Runtime files use strict
JSON; historical search and review reports belong under `.dev/audit/`.

See [maintenance.md](maintenance.md) for the complete data ownership contract.
