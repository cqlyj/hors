export const HORS_CODES = {
  HORS_UNSIGNED: 401,
  HORS_BAD_ENVELOPE: 400,
  HORS_DOMAIN_MISMATCH: 403,
  HORS_EXPIRED: 403,
  HORS_VERSION: 400,
  HORS_FUNCTION_MISMATCH: 403,
  HORS_ARGS_MISMATCH: 403,
  HORS_BAD_SIGNATURE: 403,
  HORS_REPLAY: 403,
  HORS_DENIED_WALLET: 403,
  HORS_NOT_HUMAN: 403,
  HORS_ORIGIN_MISMATCH: 403,
  HORS_RULE_DENIED: 403,
  HORS_POLICY_ERROR: 500,
  HORS_LOCAL_DISABLED: 403,
  HORS_OWNER_UNRESOLVED: 503,
  HORS_UNAVAILABLE: 503,
} as const;

export type HorsCode = keyof typeof HORS_CODES;

export const SDK_CODES = [
  "PROFILE_NOT_FOUND",
  "CONFIG_INVALID",
  "RESOLVER_FAILED",
  "REGISTRATION_FAILED",
] as const;

export const POLICY_FAILED_REASON = "policy evaluation failed";
export const NO_POLICY_REASON = "no HORS policy is registered for this tool";

const CUSTOM_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const branded = new WeakSet<HorsError>();

export function echo(text: string): string {
  return text.length > 64 ? text.slice(0, 64) : text;
}

export function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isHorsCode(code: string): code is HorsCode {
  return Object.hasOwn(HORS_CODES, code);
}

const SDK_CODE_SET: ReadonlySet<string> = new Set(SDK_CODES);

export function httpStatus(code: string): number {
  return isHorsCode(code) ? HORS_CODES[code] : 403;
}

export function isCustomCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    CUSTOM_CODE.test(code) &&
    !code.startsWith("HORS_") &&
    !SDK_CODE_SET.has(code)
  );
}

export function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export function denial(
  code: string,
  reason: string,
  challenge?: unknown,
  options?: ErrorOptions,
): HorsError {
  const error = new HorsError(
    code,
    reason,
    challenge === undefined ? undefined : { challenge },
    options,
  );
  branded.add(error);
  return error;
}

export function isDenial(error: unknown): error is HorsError {
  return error instanceof HorsError && branded.has(error);
}

export function isPolicyDenial(error: unknown): error is HorsError {
  return isDenial(error) || (error instanceof HorsError && isCustomCode(codeOf(error)));
}

export class HorsError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(code: string, message: string, data?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = "HorsError";
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

export function badEnvelope(constraint: string): never {
  throw new HorsError("HORS_BAD_ENVELOPE", `bad envelope: ${constraint}`);
}
