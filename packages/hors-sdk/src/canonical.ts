import { HorsError } from "./errors.js";

// WHY: a protocol constant so signer and gate agree; not a stack guard.
const MAX_NESTING = 512;

function badJson(detail: string): never {
  throw new HorsError("HORS_BAD_ENVELOPE", `arguments are not JSON: ${detail}`);
}

function walk(value: unknown, depth: number): string | undefined {
  if (value !== null && typeof value === "object") {
    const toJSON = Reflect.get(value, "toJSON");
    if (typeof toJSON === "function") {
      // WHY: toJSON is consulted once and not again on its own result
      // (ECMA-262 SerializeJSONProperty does the same).
      value = toJSON.call(value);
    }
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    value = value.valueOf();
  }
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      badJson("non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    badJson("bigint");
  }
  if (typeof value === "function") {
    badJson("function");
  }
  if (typeof value === "symbol") {
    badJson("symbol");
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      badJson("lone surrogate");
    }
    return JSON.stringify(value);
  }
  if (depth >= MAX_NESTING) {
    badJson("nesting deeper than 512 levels");
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (element) => walk(element, depth + 1) ?? "null").join(",")}]`;
  }
  // WHY: JSON.stringify reorders integer-index keys, which would break RFC 8785 §3.2.3.
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!key.isWellFormed()) {
      badJson("lone surrogate");
    }
  }
  keys.sort();
  const parts: string[] = [];
  for (const key of keys) {
    const serialised = walk((value as Record<string, unknown>)[key], depth + 1);
    if (serialised !== undefined) {
      parts.push(`${JSON.stringify(key)}:${serialised}`);
    }
  }
  return `{${parts.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  try {
    const json = walk(value, 0);
    if (json === undefined) {
      badJson("undefined");
    }
    return json;
  } catch (error) {
    if (error instanceof HorsError) {
      throw error;
    }
    throw new HorsError(
      "HORS_BAD_ENVELOPE",
      "arguments are not JSON: serialisation failed",
      undefined,
      { cause: error },
    );
  }
}
