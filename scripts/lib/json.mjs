import { readFileSync, writeFileSync } from "node:fs";

/** Parse strict JSON without rounding integer tokens outside Number's safe range. */
export function parseJson(source) {
  return JSON.parse(source, (_key, value, context) => {
    if (typeof value !== "number") {
      return value;
    }
    if (Object.is(value, -0)) {
      return value;
    }
    if (context?.source && /^-?\d+$/.test(context.source)) {
      const integer = BigInt(context.source);
      return integer >= BigInt(Number.MIN_SAFE_INTEGER) &&
        integer <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(integer)
        : integer;
    }
    if (!Number.isFinite(value)) {
      throw new RangeError("JSON numbers must be finite");
    }
    return value;
  });
}

/** Canonical file encoding: two spaces, explicit numeric types, one final newline. */
export function stringifyJson(value, { sortKeys = false } = {}) {
  const output = JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === "bigint") {
        return JSON.rawJSON(String(item));
      }
      if (typeof item === "number") {
        if (!Number.isFinite(item)) {
          throw new TypeError("JSON numbers must be finite");
        }
        if (Object.is(item, -0)) {
          return JSON.rawJSON("-0.0");
        }
        if (Number.isInteger(item) && !Number.isSafeInteger(item)) {
          return JSON.rawJSON(item.toExponential());
        }
      }
      if (
        sortKeys &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        !JSON.isRawJSON(item)
      ) {
        return Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      }
      return item;
    },
    2,
  );
  if (output === undefined) {
    throw new TypeError("JSON root must be serializable");
  }
  return output + "\n";
}
export function readJson(file) {
  return parseJson(readFileSync(file, "utf8"));
}
export function writeJson(file, value, options) {
  writeFileSync(file, stringifyJson(value, options), "utf8");
}
