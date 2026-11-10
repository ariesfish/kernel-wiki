import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
function files(directory) {
  return fs
    .readdirSync(directory, {
      withFileTypes: true,
    })
    .flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (["__pycache__", "node_modules"].includes(entry.name)) {
        return [];
      }
      return entry.isDirectory() ? files(full) : [full];
    });
}
test("repository executables and tests contain no Python implementation", () => {
  const implementations = [
    ...files(path.join(root, "scripts")),
    ...files(path.join(root, "tests")),
    ...files(path.join(root, "references")),
  ];
  assert.deepEqual(
    implementations.filter((file) => file.endsWith(".py")),
    [],
  );
  assert.ok(!fs.existsSync(path.join(root, "pyproject.toml")));
  assert.ok(!fs.existsSync(path.join(root, "uv.lock")));
  for (const file of implementations.filter((file) => file.endsWith(".mjs"))) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*["'](?:python(?:3(?:\.\d+)?)?|uv)["']/,
      path.relative(root, file),
    );
  }
});
test("documented maintenance commands resolve to JavaScript tools", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!command.startsWith("node scripts/")) {
      continue;
    }
    const match = /^node (scripts\/[\S]+\.mjs)(?:\s|$)/.exec(command);
    assert.ok(match, `${name}: ${command}`);
    assert.ok(fs.existsSync(path.join(root, match[1])), `${name}: missing ${match[1]}`);
  }
  for (const name of ["README.md", "SKILL.md", "SCHEMA.md"]) {
    const source = fs.readFileSync(path.join(root, name), "utf8");
    assert.doesNotMatch(source, /\buv run\b|scripts\/[A-Za-z_-]+\.py\b/, name);
  }
});
