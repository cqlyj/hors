import { base64ToBytes, bytesToBase64 } from "../base64.js";
import { HorsError } from "../errors.js";

export function encodeHeaderJson(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeHeaderJson(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(value)));
  } catch {
    throw new HorsError("HORS_BAD_ENVELOPE", "header is not base64 JSON");
  }
}
