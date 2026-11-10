# JavaScript conventions

Runtime tools are JavaScript ESM (`.mjs`) and run on Node.js >= 22 without an
installation step. Contributor tools require Node.js >= 22.13 or >= 24, as
required by the supported ESLint release.

## Files and modules

- Use kebab-case for new filenames. Put command entry points in `scripts/`,
  shared implementation in `scripts/lib/`, and committed third-party bundles
  and licenses in `scripts/vendor/`.
- `get_page.mjs`, `grep_wiki.mjs`, and `repo_status.mjs` retain their published
  filenames for existing consumers, including pi-kernel-expert. Their exports
  and internal code follow the same JavaScript conventions as other modules.
- Use camelCase for functions, parameters, and local variables; PascalCase for
  classes; and UPPER_SNAKE_CASE for shared constants. Use exports and module
  boundaries to express visibility.
- Preserve external schema keys such as `upstream_files_sha256` and
  `evidence_paths`. They are data contracts, not JavaScript binding names.

## Tests

Place `*.test.mjs` files directly in `tests/`, reusable setup in
`tests/helpers/`, and static inputs in `tests/fixtures/`. Use named imports
from `node:test` and strict assertions from `node:assert/strict`.

Test observable behavior and failure paths through public functions or CLI
commands. Keep temporary state isolated and register its cleanup. Frozen
Python inputs retain their original names and field keys; the parity test
maps historical function names to current camelCase exports.

## Checks

```bash
npm ci
npm run lint
npm run format:check
npm test
```

Use `npm run lint:fix` and `npm run format` to apply safe fixes. Prettier owns
formatting; ESLint checks correctness, unused variables, camelCase bindings,
explicit control-flow braces, and named import ordering. Lint requires zero
warnings.

The third-party YAML bundle, frozen fixtures, and knowledge corpus are excluded
from formatting. Narrow lint directives document control-character patterns
needed to preserve the frozen policy and extracted source bytes.

The development-only minimatch override pins the fix for
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Remove the override once ESLint's dependency range includes the fixed release.

The existing 29 corpus validation errors are documented in
[javascript-migration.md](javascript-migration.md). They do not justify
weakening the validator, lint rules, or test assertions.
