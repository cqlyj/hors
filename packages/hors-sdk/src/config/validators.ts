// Shared value checks used by validateConfig so schema.ts stays the config shape.
import { echo, HorsError } from "../errors.js";
import { isPlainObject } from "../plain.js";

export function invalid(message: string): never {
  throw new HorsError("CONFIG_INVALID", message);
}

export function rejectUnknown(
  value: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`unknown config key ${prefix}${echo(key)}`);
    }
  }
}

export function requirePlainObject(
  value: unknown,
  path: string,
  message = `${path} must be a plain object`,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    invalid(message);
  }
  return value;
}

export function requirePositiveDuration(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    invalid(`${path} must be a positive finite number`);
  }
  return value;
}

export function requireNonNegativeFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`${path} must be a finite number ≥ 0`);
  }
  return value;
}

export function requireIntegerInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function requireHttpUrl(value: unknown, path: string): string {
  if (typeof value !== "string" || !URL.canParse(value)) {
    invalid(`${path} must be an http(s) URL`);
  }
  const protocol = new URL(value).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    invalid(`${path} must be an http(s) URL`);
  }
  return value;
}

export function nestedObject(
  raw: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const value = requirePlainObject(raw, path);
  rejectUnknown(value, new Set(keys), `${path}.`);
  return value;
}
