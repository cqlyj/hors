import { canonicalJson } from "./canonical.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // SubtleCrypto.digest rejects a view over a SharedArrayBuffer
  // (TypeError: … is a view on a SharedArrayBuffer). HTTP bodies can be large;
  // do not copy them without reason.
  const data = bytes.buffer instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function hashArgs(value: unknown): Promise<string> {
  const json = canonicalJson(value === undefined ? {} : value);
  return sha256Hex(new TextEncoder().encode(json));
}

export async function hashBody(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}
