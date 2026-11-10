# Bundled YAML implementations

Two independent YAML readers are vendored here so a cloned skill works with
no package installation and no network access.

## Python maintenance: `yaml/`

The `yaml/` package is the pure-Python portion of PyYAML 6.0.3. It is loaded
through `scripts/_yaml_compat.py`, which prefers the host PyYAML installation
when one is available and falls back to this copy otherwise. Only the
maintenance tooling uses it; the query layer is Node.js.

The optional C extension is intentionally not included. PyYAML is distributed
under the MIT license; see `LICENSE`.

## Node query layer: `yaml.mjs`

`yaml.mjs` is a single-file ESM bundle of the `yaml` package 2.9.1 (ISC),
built with esbuild. It exports `parse` and `stringify` and is imported by
`scripts/_yaml.mjs`. Rebuild it with `npm run build:yaml` after changing the
`yaml` version in `package.json`; commit the refreshed bundle and
`yaml.LICENSE`. The browser entry is used because the Node entry is CommonJS
and needs a runtime `require("process")`, which a self-contained ESM bundle
cannot resolve.
