import type { CallToolResult, Transport } from "@modelcontextprotocol/client";
import type { Account } from "viem";
import type { Envelope } from "../envelope.js";
import type { HorsResultMeta } from "../gate/result.js";
import type { Address, ChainId, HumanId } from "../identity.js";

export interface CallInfo {
  url: string;
  fn: string;
  argsHash: string;
}

export type MetaOption =
  | Record<string, unknown>
  | ((call: CallInfo) => Record<string, unknown> | Promise<Record<string, unknown>>);

export interface SignerOptions {
  readonly profile?: string;
  readonly account?: Account;
  readonly chainId?: ChainId;
  readonly meta?: MetaOption;
  readonly expirySeconds?: number;
  readonly services?: Record<string, string>;
  readonly rpc?: { ens?: string; signatures?: Record<string, string> };
  readonly cache?: false | { home?: string };
  readonly fetch?: typeof fetch;
}

export interface Signer {
  readonly address: Address;
  readonly humanId: HumanId | null;
  sign(call: CallInfo): Promise<Envelope>;
  wrapTransport(transport: Transport, opts: { url: string; meta?: MetaOption }): Transport;
  fetch(
    input: Request | URL | string,
    init?: RequestInit & { meta?: Record<string, unknown> },
  ): Promise<Response>;
  call(
    service: string,
    fn: string,
    args: unknown,
    opts?: { meta?: Record<string, unknown>; refresh?: boolean; signal?: AbortSignal },
  ): Promise<CallOutcome>;
}

export type CallOutcome =
  | { ok: true; result: CallToolResult; hors: HorsResultMeta | null }
  | { ok: false; code: string; reason: string; challenge: unknown; hors: HorsResultMeta };
