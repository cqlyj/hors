import { HorsError } from "../errors.js";
import { isHorsResultMeta } from "../gate/result.js";
import { VERSION } from "../version.js";
import type { CallOutcome, MetaOption, Signer } from "./types.js";

export async function callService(
  signer: Signer,
  deps: {
    services?: Record<string, string>;
    rpc?: { ens?: string; signatures?: Record<string, string> };
    cache?: false | { home?: string };
    fetch: typeof fetch;
  },
  service: string,
  fn: string,
  args: unknown,
  opts?: { meta?: Record<string, unknown>; refresh?: boolean; signal?: AbortSignal },
): Promise<CallOutcome> {
  const { resolve } = await import("../resolvers/resolve.js");
  const url = await resolve(service, {
    services: deps.services,
    rpc: deps.rpc,
    fetch: deps.fetch,
    cache: deps.cache,
    refresh: opts?.refresh,
  });
  let clientMod: typeof import("@modelcontextprotocol/client");
  try {
    clientMod = await import("@modelcontextprotocol/client");
  } catch (error) {
    throw new HorsError(
      "CONFIG_INVALID",
      "call() needs @modelcontextprotocol/client; install it or use fetch()",
      undefined,
      { cause: error },
    );
  }
  const { Client, StreamableHTTPClientTransport } = clientMod;
  const meta: MetaOption | undefined = opts?.meta;
  const transport = signer.wrapTransport(
    new StreamableHTTPClientTransport(new URL(url), { fetch: deps.fetch }),
    { url, meta },
  );
  const client = new Client({ name: "hors-sdk", version: VERSION });
  const signal = opts?.signal;
  try {
    await client.connect(transport, signal === undefined ? undefined : { signal });
    const params =
      args === undefined
        ? { name: fn }
        : // MCP callTool arguments are a JSON object; the signer hashed `args` as given.
          { name: fn, arguments: args as Record<string, unknown> };
    const result = await client.callTool(params, signal === undefined ? undefined : { signal });
    const stamp = result._meta?.["hors/result"];
    if (stamp === undefined) {
      return { ok: true, result, hors: null };
    }
    if (!isHorsResultMeta(stamp)) {
      throw new HorsError("HORS_POLICY_ERROR", "service returned a malformed hors/result");
    }
    if (stamp.status === "deny") {
      return {
        ok: false,
        code: stamp.code ?? "",
        reason: stamp.reason ?? "",
        challenge: stamp.challenge ?? null,
        hors: stamp,
      };
    }
    return { ok: true, result, hors: stamp };
  } finally {
    try {
      await client.close();
    } catch {
      // The transport is per call and already unusable; the outcome wins.
    }
  }
}
