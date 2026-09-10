import {
  codeOf,
  HORS_CODES,
  HorsError,
  httpStatus,
  isCustomCode,
  POLICY_FAILED_REASON,
  thrownMessage,
} from "../errors.js";
import { isPlainObject } from "../plain.js";
import type { Logger } from "./logger.js";

export const MAX_REASON_LENGTH = 1024;

export interface HorsResultMeta {
  readonly v: 1;
  readonly status: "ok" | "deny";
  readonly code?: string; // deny only
  readonly reason?: string; // deny only
  readonly policy: string | null; // preset or named policy; null for inline objects
  readonly challenge?: unknown; // deny only; null when the denial carries none
  readonly local: boolean;
  readonly mock?: true; // present only in dev mode
}

export function isHorsResultMeta(value: unknown): value is HorsResultMeta {
  if (!isPlainObject(value) || value.v !== 1) {
    return false;
  }
  if (value.status === "ok") {
    return true;
  }
  return (
    value.status === "deny" &&
    typeof value.code === "string" &&
    typeof value.reason === "string" &&
    "challenge" in value
  );
}

export interface Denial {
  readonly code: string; // a HORS_* code or a custom code
  readonly status: number; // the code's HTTP status; 403 for custom codes
  readonly reason: string; // safe to show the caller
  readonly challenge: unknown; // null when absent
  readonly text: string; // `${code}: ${reason}` — the MCP text block
  readonly result: HorsResultMeta; // status "deny"
}

function boundReason(reason: string): string {
  // WHY: a rule author's deny: "" must still produce a non-empty text.
  if (reason === "") {
    return "denied";
  }
  // Host and other echoed request values can carry undici-permitted C0/DEL bytes.
  let clean = "";
  for (const ch of reason) {
    const code = ch.charCodeAt(0);
    clean += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return clean.length > MAX_REASON_LENGTH ? clean.slice(0, MAX_REASON_LENGTH) : clean;
}

export function okResult(
  policy: { readonly name?: string },
  local: boolean,
  mock: boolean,
): HorsResultMeta {
  return {
    v: 1,
    status: "ok",
    policy: policy.name ?? null,
    local,
    ...(mock ? { mock: true as const } : {}),
  };
}

export function denialFrom(
  error: unknown,
  call: { policy: { readonly name?: string }; local: boolean; mock: boolean; log: Logger },
): Denial {
  let code: string;
  let status: number;
  let reason: string;
  let challenge: unknown = null;

  const read = codeOf(error);
  if (
    error instanceof HorsError &&
    read !== undefined &&
    (Object.hasOwn(HORS_CODES, read) || isCustomCode(read))
  ) {
    code = read;
    status = httpStatus(read);
    reason = boundReason(error.message);
    const data = error.data;
    if (isPlainObject(data) && Object.hasOwn(data, "challenge")) {
      try {
        // Round-trip so members JSON drops (functions, symbols, undefined) vanish
        // on in-memory transports the same way they do on stdio/HTTP.
        challenge = JSON.parse(JSON.stringify(data.challenge));
      } catch {
        call.log("error", "challenge is not JSON; dropped");
        challenge = null;
      }
    }
  } else {
    call.log("error", "gate failure", { message: thrownMessage(error) });
    code = "HORS_POLICY_ERROR";
    status = 500;
    reason = POLICY_FAILED_REASON;
  }

  return {
    code,
    status,
    reason,
    challenge,
    text: `${code}: ${reason}`,
    result: {
      v: 1,
      status: "deny",
      code,
      reason,
      policy: call.policy.name ?? null,
      challenge,
      local: call.local,
      ...(call.mock ? { mock: true as const } : {}),
    },
  };
}

export function policyError(
  gate: { readonly mock: boolean; readonly log: Logger },
  call: { policy: { readonly name?: string }; local: boolean },
): Denial {
  return denialFrom(new HorsError("HORS_POLICY_ERROR", POLICY_FAILED_REASON), {
    policy: call.policy,
    local: call.local,
    mock: gate.mock,
    log: gate.log,
  });
}
