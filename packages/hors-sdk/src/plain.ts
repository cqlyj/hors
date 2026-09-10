// Structural checks shared across adapters: plain objects, control characters,
// and Web Request/Response (never instanceof — globals may be patched).

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function isWebRequest(value: unknown): value is Request {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Request).url === "string" &&
    typeof (value as Request).headers?.get === "function"
  );
}

export function isWebResponse(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Response).status === "number" &&
    typeof (value as Response).headers?.get === "function" &&
    typeof (value as Response).arrayBuffer === "function"
  );
}

export function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
