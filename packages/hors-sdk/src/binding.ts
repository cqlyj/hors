import { badEnvelope, HorsError } from "./errors.js";

export const HORS_VERSION_URN = "urn:hors:v:1";
export const ARGS_URN_PATTERN = /^urn:hors:args:sha256:[0-9a-f]{64}$/;

const FN_URN_PREFIX = "urn:hors:fn:";
const FN_URN_REMAINDER = /^(?:[A-Za-z0-9._-]|%[0-9A-F]{2})+$/;
export const ARGS_HASH = /^[0-9a-f]{64}$/;
const EXTRA_ENCODE: Record<string, string> = {
  "!": "%21",
  "'": "%27",
  "(": "%28",
  ")": "%29",
  "*": "%2A",
  "~": "%7E",
};

function badFunctionId(): never {
  throw new HorsError("HORS_BAD_ENVELOPE", "function id must be a non-empty well-formed string");
}

export function encodeFunctionId(fn: string): string {
  if (fn === "") {
    badFunctionId();
  }
  try {
    return encodeURIComponent(fn).replace(/[!'()*~]/g, (ch) => EXTRA_ENCODE[ch] ?? ch);
  } catch (error) {
    if (error instanceof URIError) {
      badFunctionId();
    }
    throw error;
  }
}

export function functionUrn(fn: string): string {
  return FN_URN_PREFIX + encodeFunctionId(fn);
}

export function functionIdFromUrn(urn: string): string {
  if (!urn.startsWith(FN_URN_PREFIX)) {
    badEnvelope("function URN must use the urn:hors:fn: prefix");
  }
  const remainder = urn.slice(FN_URN_PREFIX.length);
  if (!FN_URN_REMAINDER.test(remainder)) {
    badEnvelope("function URN remainder is not a valid percent-encoded function id");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(remainder);
  } catch {
    // Invalid UTF-8 in the percent-escapes; fail closed rather than guess.
    badEnvelope("function URN remainder is not valid UTF-8");
  }
  if (functionUrn(decoded) !== urn) {
    badEnvelope("function URN is not in canonical form");
  }
  return decoded;
}

export function argsUrn(argsHash: string): string {
  if (!ARGS_HASH.test(argsHash)) {
    badEnvelope("args hash must be 64 lowercase hex characters");
  }
  return `urn:hors:args:sha256:${argsHash}`;
}

export function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

export function httpFunctionId(method: string, path: string): string {
  if (path.includes("?") || path.includes("#")) {
    badEnvelope("path must not contain a query or fragment");
  }
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}
