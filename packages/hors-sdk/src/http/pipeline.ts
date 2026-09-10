import type { Gate } from "../gate/gate.js";
import { hashBody } from "../hash.js";
import { isWebResponse } from "../plain.js";
import type { CompiledPolicy, HorsContext } from "../policy/types.js";
import type { RequestLocation } from "../verify/expected-url.js";
import { parseJsonArgs } from "./body.js";
import { decodeHeaderJson } from "./envelope-header.js";
import { denialResponse, policyError, stampResponse } from "./response.js";

function decodeHeader(value: string | null | undefined): unknown {
  if (value == null) {
    return undefined;
  }
  try {
    return decodeHeaderJson(value);
  } catch {
    return value;
  }
}

function decodePair(
  authorization: string | null | undefined,
  meta: string | null | undefined,
): { envelope: unknown; meta: unknown } {
  return { envelope: decodeHeader(authorization), meta: decodeHeader(meta) };
}

export async function runHttpCall(
  gate: Gate,
  compiled: CompiledPolicy | undefined,
  input: {
    fn: string;
    bytes: Uint8Array;
    contentType: string | null;
    authorization: string | null | undefined;
    meta: string | null | undefined;
    url: RequestLocation;
    request: unknown;
    handler?: (ctx: HorsContext) => unknown;
  },
): Promise<Response | { decision: Extract<Awaited<ReturnType<Gate["evaluate"]>>, { ok: true }> }> {
  const argsHash = await hashBody(input.bytes);
  const args = parseJsonArgs(input.bytes, input.contentType);
  const { envelope, meta } = decodePair(input.authorization, input.meta);
  const decision = await gate.evaluate({
    fn: input.fn,
    argsHash,
    args,
    envelope,
    meta,
    transport: "http",
    local: false,
    request: input.request,
    url: input.url,
    policy: compiled,
    handler: input.handler,
  });
  if (!decision.ok) {
    return denialResponse(decision.denial);
  }
  if (input.handler !== undefined) {
    if (!isWebResponse(decision.value)) {
      gate.log("error", "handler did not return a Response", { fn: input.fn });
      return denialResponse(policyError(gate, compiled ?? gate.policyFor(input.fn)));
    }
    return stampResponse(decision.value, decision.result);
  }
  return { decision };
}
