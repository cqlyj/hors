import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import type { Envelope } from "../envelope.js";
import { hashArgs } from "../hash.js";
import { proxyTransport } from "../mcp/proxy.js";
import { isPlainObject } from "../plain.js";
import type { CallInfo, MetaOption } from "./types.js";

export async function resolveMeta(
  meta: MetaOption | undefined,
  call: CallInfo,
): Promise<Record<string, unknown> | undefined> {
  if (meta === undefined) {
    return undefined;
  }
  return typeof meta === "function" ? await meta(call) : meta;
}

function hasRequestId(value: unknown): boolean {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

export function signingTransport(
  real: Transport,
  signer: { sign(call: CallInfo): Promise<Envelope> },
  opts: { url: string; meta?: MetaOption },
): Transport {
  return proxyTransport(real, {
    inbound: () => "forward",
    async outbound(message) {
      const body: unknown = message;
      if (!isPlainObject(body) || body.method !== "tools/call" || !hasRequestId(body.id)) {
        return;
      }
      const params = body.params;
      if (!isPlainObject(params) || typeof params.name !== "string") {
        return;
      }
      const fn = params.name;
      const argsHash = await hashArgs(params.arguments ?? {});
      const call = { url: opts.url, fn, argsHash };
      const envelope = await signer.sign(call);
      const meta = await resolveMeta(opts.meta, call);
      // body was checked as a tools/call JSON-RPC request above.
      const next: JSONRPCMessage = {
        ...(body as JSONRPCMessage),
        params: {
          ...params,
          _meta: {
            ...(isPlainObject(params._meta) ? params._meta : {}),
            "hors/auth": envelope,
            ...(meta === undefined ? {} : { "hors/meta": meta }),
          },
        },
      };
      return next;
    },
    closed() {},
  });
}
