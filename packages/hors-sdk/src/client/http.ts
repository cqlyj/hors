import { httpFunctionId } from "../binding.js";
import { HorsError } from "../errors.js";
import { type HorsResultMeta, isHorsResultMeta } from "../gate/result.js";
import { hashBody } from "../hash.js";
import { decodeHeaderJson, encodeHeaderJson } from "../http/envelope-header.js";
import { resolveMeta } from "./transport.js";
import type { CallInfo, MetaOption, Signer } from "./types.js";

export function readResult(response: Response): HorsResultMeta | null {
  const header = response.headers.get("HORS-Result");
  if (header === null) {
    return null;
  }
  let value: unknown;
  try {
    value = decodeHeaderJson(header);
  } catch {
    throw new HorsError("HORS_POLICY_ERROR", "service returned a malformed hors/result");
  }
  if (!isHorsResultMeta(value)) {
    throw new HorsError("HORS_POLICY_ERROR", "service returned a malformed hors/result");
  }
  return value;
}

export function signedFetch(
  signer: Pick<Signer, "sign">,
  fetchImpl: typeof fetch,
  defaultMeta?: MetaOption,
): Signer["fetch"] {
  return async (input, init) => {
    const { meta: initMeta, ...rest } = init ?? {};
    // RequestInit & { meta } is not a RequestInit; drop meta before constructing.
    const request = new Request(input, rest as RequestInit);
    const method = request.method.toUpperCase();
    const bytes = new Uint8Array(await request.arrayBuffer());
    const parsed = new URL(request.url);
    const url = parsed.origin + parsed.pathname;
    const fn = httpFunctionId(method, parsed.pathname);
    const argsHash = await hashBody(bytes);
    const envelope = await signer.sign({ url, fn, argsHash });
    const meta =
      initMeta ?? (await resolveMeta(defaultMeta, { url, fn, argsHash } satisfies CallInfo));
    const headers = new Headers(request.headers);
    headers.set("HORS-Authorization", encodeHeaderJson(envelope));
    if (meta !== undefined) {
      headers.set("HORS-Meta", encodeHeaderJson(meta));
    }
    return fetchImpl(new Request(request, { headers, body: bytes.byteLength ? bytes : null }));
  };
}
