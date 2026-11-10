#!/usr/bin/env node
/**
 * Rebuild scripts/vendor/yaml.mjs from the pinned `yaml` devDependency.
 *
 * The query layer must run from a bare `git clone` with no `npm install`, so
 * the parser is committed as a single ESM bundle. Run `npm run build:yaml`
 * after changing the `yaml` version in package.json, then commit both the
 * bundle and the refreshed license file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(
  readFileSync(path.join(ROOT, "node_modules", "yaml", "package.json"), "utf8"),
);
await build({
  stdin: {
    contents: 'export { parse, stringify } from "yaml";',
    resolveDir: ROOT,
    sourcefile: "yaml-entry.mjs",
    loader: "js",
  },
  bundle: true,
  format: "esm",
  // The package's Node entry is CommonJS and pulls in `require("process")`.
  // The browser entry is ESM and self-contained, which is what a single-file
  // vendored module needs; its parser is the same implementation.
  platform: "browser",
  target: "node22",
  minify: true,
  legalComments: "none",
  outfile: path.join(ROOT, "scripts", "vendor", "yaml.mjs"),
  banner: {
    js: `/*! yaml v${PACKAGE.version} | ${PACKAGE.license} | https://github.com/eemeli/yaml */`,
  },
});
writeFileSync(
  path.join(ROOT, "scripts", "vendor", "yaml.LICENSE"),
  readFileSync(path.join(ROOT, "node_modules", "yaml", "LICENSE")),
);
console.log(`vendored yaml ${PACKAGE.version} -> scripts/vendor/yaml.mjs`);
