import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJson, readJson, stringifyJson, writeJson } from "../scripts/lib/json.mjs";
test("machine data accepts strict JSON and keeps date and SHA strings", () => {
  assert.deepEqual(parseJson('{"date":"2026-08-18","sha":"0e026982","enabled":true}'), {
    date: "2026-08-18",
    sha: "0e026982",
    enabled: true,
  });
  assert.throws(() => parseJson("enabled: true\n"), SyntaxError);
  assert.throws(() => parseJson('{"enabled":true,}'), SyntaxError);
});
test("JSON preserves exact integers and floating-point values during repeated writes", () => {
  const first = parseJson(
    '{"id":9007199254740993,"count":42,"small":1e-7,"large":1e20,"negativeZero":-0.0}',
  );
  assert.equal(first.id, 9007199254740993n);
  assert.equal(first.count, 42);
  assert.equal(typeof first.large, "number");
  assert.ok(Object.is(parseJson("-0"), -0));
  assert.equal(parseJson("-9007199254740993"), -9007199254740993n);
  const once = stringifyJson(first);
  assert.deepEqual(parseJson(once), first);
  assert.equal(stringifyJson(parseJson(once)), once);
});
test("JSON serialization is deterministic, readable and optionally sorts keys", () => {
  assert.equal(
    stringifyJson({
      b: 2,
      a: 1,
    }),
    '{\n  "b": 2,\n  "a": 1\n}\n',
  );
  assert.equal(
    stringifyJson(
      {
        b: {
          d: 4,
          c: 3,
        },
        a: 1,
      },
      {
        sortKeys: true,
      },
    ),
    '{\n  "a": 1,\n  "b": {\n    "c": 3,\n    "d": 4\n  }\n}\n',
  );
});
test("JSON refuses non-finite values instead of silently writing null", () => {
  assert.throws(() => parseJson('{"value":1e999}'), /finite/);
  for (const value of [Infinity, -Infinity, NaN]) {
    assert.throws(
      () =>
        stringifyJson({
          value,
        }),
      /finite/,
    );
  }
});
test("JSON file IO reports malformed input and supports independent working directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-wiki-json-"));
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
    }),
  );
  const file = path.join(root, "data.json");
  const value = {
    id: 9007199254740993n,
    date: "2026-08-18T12:34:56.123456+02:00",
  };
  writeJson(file, value);
  assert.deepEqual(readJson(file), value);
  fs.writeFileSync(file, '{"broken":');
  assert.throws(() => readJson(file), SyntaxError);
});
