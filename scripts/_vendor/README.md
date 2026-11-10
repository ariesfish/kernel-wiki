# Vendored YAML parser

`yaml.mjs` is a committed, self-contained ESM bundle of `yaml` 2.9.1
(ISC), built with esbuild. All query and maintenance scripts import
`parse` and `stringify` through `scripts/_yaml.mjs`.

A fresh clone needs no package installation or network access to parse YAML.
Python and PyYAML are not used by repository tooling. Python files in
`artifacts/` are immutable upstream source evidence.

To rebuild after updating the `yaml` dependency:

```bash
npm ci
npm run build:yaml
npm test
```

Commit the refreshed bundle and `yaml.LICENSE`. The browser entry is used
because the Node entry is CommonJS and needs a runtime `require("process")`,
which a self-contained ESM bundle cannot resolve.
