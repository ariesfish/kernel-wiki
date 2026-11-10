import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dump_sorted } from "../../scripts/compute-core-prs.mjs";

export function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "wiki"));
  put(root, "data/tags.yaml", "tags: []\n");
  put(root, "data/inclusion-policy.yaml", "{}\n");
  return root;
}
export function put(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
export function page(root, relative, fm, body = "body\n") {
  return put(root, relative, `---\n${dump_sorted(fm)}---\n${body}`);
}
export function pr(root, number, extra = {}) {
  const fm = { id: `pr-demo-${number}`, repo: "example/demo", pr: number, merge_sha: "abcdef12", changed_paths: ["src/kernel.cu"], ...extra };
  page(root, `sources/prs/demo/PR-${number}.md`, fm);
  return fm;
}
export function quiet(root, extra = {}) { return { root, log() {}, warn() {}, ...extra }; }
