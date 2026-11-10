import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as indices from "../scripts/generate-indices.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const generators = [
  "architecture",
  "problem",
  "technique",
  "hardware-feature",
  "repo",
  "kernel-type",
  "language",
];
function fixture(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "wiki-indices-")),
    previous = indices.REPO_ROOT;
  indices.configureRoot(root);
  try {
    return callback(root);
  } finally {
    indices.configureRoot(previous);
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
function run(root) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts/generate-indices.mjs")], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      BLACKWELL_WIKI_ROOT: root,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
}
test("all seven generators reproduce the committed indices byte for byte", () => {
  const pages = indices.collectAllPages();
  assert.equal(pages.length, 1042);
  for (const name of generators) {
    assert.equal(
      indices[
        `generateBy${name
          .split("-")
          .map((part) => part[0].toUpperCase() + part.slice(1))
          .join("")}`
      ](pages),
      readFileSync(path.join(ROOT, `queries/by-${name}.md`), "utf8"),
      name,
    );
  }
});
test("index CLI uses module-relative default root and is inert on import", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(new URL("../scripts/generate-indices.mjs", import.meta.url).href)}); console.log(m.REPO_ROOT);`,
    ],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        BLACKWELL_WIKI_ROOT: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.resolve(ROOT));
});
test("index CLI writes only configured fixture queries and can run twice", () =>
  fixture((root) => {
    for (const name of ["sources", "wiki", "data"]) {
      symlinkSync(path.join(ROOT, name), path.join(root, name), "dir");
    }
    for (let i = 0; i < 2; i++) {
      const result = run(root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Collected 1042 pages/);
      assert.equal(readdirSync(path.join(root, "queries")).length, 7);
      for (const name of generators) {
        assert.equal(
          readFileSync(path.join(root, `queries/by-${name}.md`), "utf8"),
          readFileSync(path.join(ROOT, `queries/by-${name}.md`), "utf8"),
        );
      }
    }
  }));
test("index CLI rejects missing, malformed and nonmapping frontmatter before replacing indices", () =>
  fixture((root) => {
    mkdirSync(path.join(root, "sources"));
    mkdirSync(path.join(root, "queries"));
    writeFileSync(path.join(root, "sources/missing.md"), "# No frontmatter");
    writeFileSync(path.join(root, "sources/broken.md"), "---\nx: [\n---\n");
    writeFileSync(path.join(root, "sources/scalar.md"), "---\nscalar\n---\n");
    const sentinel = path.join(root, "queries/by-repo.md");
    writeFileSync(sentinel, "Keep old index");
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ERROR: 3 files/);
    assert.match(result.stdout, /frontmatter is str, not a mapping/);
    assert.match(result.stdout, /Run node scripts\/validate.mjs first/);
    assert.equal(readFileSync(sentinel, "utf8"), "Keep old index");
  }));
test("structured language and kernel fields override fallback tags while hardware tags merge", () =>
  fixture((root) => {
    mkdirSync(path.join(root, "data"));
    writeFileSync(
      path.join(root, "data/tags.yaml"),
      "languages: [cuda, triton]\nkernel_types: [gemm, attention]\nhardware_features: [tma, tmem]\n",
    );
    const page = {
      id: "p",
      title: "Page",
      _path: "wiki/kernels/page.md",
      type: "kernel",
      languages: ["cuda"],
      kernel_types: ["gemm"],
      hardware_features: ["tma"],
      tags: ["triton", "attention", "tmem"],
    };
    const language = indices.generateByLanguage([page]),
      kernel = indices.generateByKernelType([page]),
      hardware = indices.generateByHardwareFeature([page]);
    assert.match(language, /`cuda`/);
    assert.doesNotMatch(language, /`triton`/);
    assert.match(kernel, /`gemm`/);
    assert.doesNotMatch(kernel, /`attention`/);
    assert.match(hardware, /`tma`/);
    assert.match(hardware, /`tmem`/);
    const fallback = {
      ...page,
      languages: [],
      kernel_types: [],
    };
    assert.match(indices.generateByLanguage([fallback]), /`triton`/);
    assert.match(indices.generateByKernelType([fallback]), /`attention`/);
    assert.doesNotMatch(
      indices.generateByKernelType([
        {
          ...fallback,
          type: "technique",
        },
      ]),
      /`attention`/,
    );
  }));
