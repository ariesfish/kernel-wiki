/**
 * The shared YAML entry point for query and maintenance tools.
 *
 * `_vendor/yaml.mjs` is a committed esbuild bundle of the `yaml` package
 * (ISC, https://github.com/eemeli/yaml), so a cloned skill needs no
 * `npm install` and no Python interpreter. Rebuild it with
 * `npm run build:yaml`; see scripts/_vendor/README.md.
 */

import { parse as parseYaml, stringify } from "./_vendor/yaml.mjs";

export { parseYaml as parse, stringify };

// Preserve the original maintenance scalar grammar. In particular, `0e026982`
// is a short Git SHA in archived provenance, not the floating-point number 0.
// Query parsing retains its existing YAML 1.2 defaults.
// Preserve timestamp spelling (microseconds, timezone, and date-vs-datetime)
// while remaining a Date for existing freshness and validation comparisons.
class MaintenanceTimestamp extends Date {
  constructor(value, source) {
    super(value);
    Object.defineProperty(this, "yamlSource", { value: source });
  }
}

function maintenanceFloat(text) {
  return text.replace(/^([-+]?(?:\d+(?:\.\d*)?|\.\d+))[eE]([-+]?)(\d+)$/, (_match, mantissa, sign, exponent) =>
    `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}e${sign || "+"}${exponent}`);
}

const TIMESTAMP_PATTERN = /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$/;
function maintenanceTimestamp(source) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt]|[ \t]+)(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d*))?(?:[ \t]*(?:Z|([-+])(\d{1,2})(?::(\d{2}))?))?)?$/.exec(source);
  if (!match) throw new RangeError(`Invalid YAML timestamp: ${source}`);
  const [, y, m, d, h = "0", minute = "0", second = "0", fraction = "", sign, offsetHour = "0", offsetMinute = "0"] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  if (Number(y) < 1 || Number(m) < 1 || date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d) || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
    throw new RangeError(`Invalid YAML timestamp: ${source}`);
  }
  date.setUTCHours(Number(h), Number(minute), Number(second), Number((fraction + "000").slice(0, 3)));
  const offset = (Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === "-" ? -1 : 1);
  return new MaintenanceTimestamp(date.getTime() - offset * 60_000, source);
}

function maintenanceTags(tags) {
  return tags.map((tag) => {
    if (tag.tag === "tag:yaml.org,2002:float" || tag.tag === "tag:yaml.org,2002:int") {
      const original = tag.stringify;
      tag = { ...tag, stringify: (item, ...args) => {
        if (Object.is(item.value, -0)) return "-0.0";
        const result = original(item, ...args);
        // Integral-valued doubles must not reload as exact BigInts, including
        // the range where Number.toString() chooses ordinary decimal notation.
        if (typeof item.value === "number" && Number.isInteger(item.value) && !Number.isSafeInteger(item.value) && /^[-+]?\d+$/.test(result)) return `${result}.0`;
        return typeof item.value === "number" ? maintenanceFloat(result) : result;
      } };
    }
    if (tag.tag === "tag:yaml.org,2002:timestamp") {
      return { ...tag, test: TIMESTAMP_PATTERN,
        resolve: maintenanceTimestamp,
        stringify: (item, ...args) => item.value instanceof MaintenanceTimestamp ? item.value.yamlSource : tag.stringify(item, ...args),
      };
    }
    if (tag.tag === "tag:yaml.org,2002:bool") {
      return { ...tag, test: tag.test.test("true")
        ? /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/
        : /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/ };
    }
    if (tag.tag === "tag:yaml.org,2002:float") {
      if (tag.format === "EXP") return { ...tag, test: /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)[eE][-+][0-9]+$/ };
      if (tag.format === "TIME") return tag;
      if (tag.test.test("1.5")) return { ...tag, test: /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)$/ };
    }
    if (tag.tag === "tag:yaml.org,2002:int" && !tag.format) return { ...tag, test: /^[-+]?(?:0|[1-9][0-9_]*)$/ };
    if (tag.tag === "tag:yaml.org,2002:int" && tag.format === "TIME") return { ...tag, test: /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/ };
    return tag;
  });
}

function safeIntegers(value, seen = new WeakSet()) {
  if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  if (!value || typeof value !== "object" || value instanceof Date || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    const entries = [...value]; value.clear();
    for (const [key, item] of entries) value.set(safeIntegers(key, seen), safeIntegers(item, seen));
  } else if (value instanceof Set) {
    const entries = [...value]; value.clear();
    for (const item of entries) value.add(safeIntegers(item, seen));
  } else {
    for (const key of Object.keys(value)) value[key] = safeIntegers(value[key], seen);
  }
  return value;
}

export function parseMaintenance(source, options = {}) {
  return safeIntegers(parseYaml(source, { version: "1.1", uniqueKeys: false, ...options, intAsBigInt: true, customTags: maintenanceTags }));
}

export function stringifyMaintenance(value, options = {}) {
  // Quoting follows the reader's schema, so a date string stays a string on
  // the next refresh instead of becoming a timestamp and changing its bytes.
  return stringify(value, { version: "1.1", ...options, customTags: maintenanceTags });
}
