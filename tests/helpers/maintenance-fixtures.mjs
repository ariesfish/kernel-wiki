import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let imports = 0;

export function temp_root(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-checks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export function put(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export async function import_in_root(script, root) {
  const previous = process.env.BLACKWELL_WIKI_ROOT;
  process.env.BLACKWELL_WIKI_ROOT = root;
  try {
    const url = pathToFileURL(path.join(ROOT, "scripts", script));
    url.searchParams.set("checks-test", String(++imports));
    return await import(url.href);
  } finally {
    if (previous === undefined) delete process.env.BLACKWELL_WIKI_ROOT;
    else process.env.BLACKWELL_WIKI_ROOT = previous;
  }
}

export function run(script, args = [], root = ROOT, options = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: os.tmpdir(), encoding: "utf8", ...options,
    env: { ...process.env, BLACKWELL_WIKI_ROOT: root, ...options.env },
  });
}

export function snapshot(root) {
  const files = new Map();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.set(path.relative(root, file), fs.readFileSync(file));
    }
  }
  walk(root);
  return files;
}
