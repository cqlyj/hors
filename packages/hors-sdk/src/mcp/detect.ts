import { isPlainObject, isWebRequest } from "../plain.js";

interface DetectedCall {
  readonly local: boolean;
  readonly request: Request | undefined;
}

interface RecordedNetwork {
  readonly network?: boolean;
  readonly request?: Request;
}

function httpReqOf(ctx: unknown): Request | undefined {
  if (!isPlainObject(ctx) || !isPlainObject(ctx.http)) {
    return undefined;
  }
  return isWebRequest(ctx.http.req) ? ctx.http.req : undefined;
}

export function detectCall(input: {
  readonly override?: "stdio" | "http";
  readonly ctx: unknown;
  readonly recorded?: RecordedNetwork;
}): DetectedCall {
  const request = httpReqOf(input.ctx) ?? input.recorded?.request;
  const ctxHttp = isPlainObject(input.ctx) ? input.ctx.http : undefined;
  const network =
    input.override === "http" ||
    (input.override !== "stdio" && (ctxHttp !== undefined || input.recorded?.network === true));
  return { local: !network, request };
}
