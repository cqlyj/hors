import type { Gate } from "../gate/gate.js";
import {
  type Denial,
  policyError as gatePolicyError,
  type HorsResultMeta,
} from "../gate/result.js";
import { encodeHeaderJson } from "./envelope-header.js";

export function policyError(gate: Gate, policy: { readonly name?: string }): Denial {
  return gatePolicyError(gate, { policy, local: false });
}

export function denialResponse(denial: Denial): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    "HORS-Result": encodeHeaderJson(denial.result),
  });
  if (denial.status === 401) {
    headers.set("WWW-Authenticate", "HORS");
  }
  return new Response(
    JSON.stringify({
      v: 1,
      status: "deny",
      code: denial.code,
      reason: denial.reason,
      challenge: denial.challenge,
    }),
    { status: denial.status, headers },
  );
}

export function stampResponse(response: Response, result: HorsResultMeta): Response {
  const stamped = new Response(response.body, response);
  stamped.headers.set("HORS-Result", encodeHeaderJson(result));
  return stamped;
}

export function bodyTooLarge(maxBytes: number): Response {
  return new Response(JSON.stringify({ error: `request body exceeds ${maxBytes} bytes` }), {
    status: 413,
    headers: { "Content-Type": "application/json" },
  });
}
