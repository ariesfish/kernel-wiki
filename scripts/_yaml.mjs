/**
 * The only YAML import in the query layer.
 *
 * `_vendor/yaml.mjs` is a committed esbuild bundle of the `yaml` package
 * (ISC, https://github.com/eemeli/yaml), so a cloned skill needs no
 * `npm install` and no Python interpreter. Rebuild it with
 * `npm run build:yaml`; see scripts/_vendor/README.md.
 */

export { parse, stringify } from "./_vendor/yaml.mjs";
