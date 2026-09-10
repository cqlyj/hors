import type { Address, HumanId } from "../identity.js";
import type { Store } from "../store.js";

export type OriginFn = (ctx: HorsContext) => boolean | Promise<boolean>;
export type Origin = "same-human" | "any-human" | "public" | HumanId | OriginFn;

export type Verdict = boolean | { deny: string; code?: string; challenge?: unknown };
export type Rule = (ctx: HorsContext) => Verdict | Promise<Verdict>;

// Transport-specific: a CallToolResult under the MCP adapter, a Response under
// the HTTP adapter, the handler's return value under gate.wrap(). Policy code cannot know
// which, so at this level it is unknown; adapters narrow it at their boundary.
export type HorsResult = unknown;
export type Middleware = (ctx: HorsContext, next: () => Promise<HorsResult>) => Promise<HorsResult>;

export interface PolicyObject {
  origin?: Origin | Origin[]; // default "same-human"
  rule?: Rule | Rule[]; // default none
  use?: Middleware | Middleware[]; // default none
  describe?: string;
}
export type Policy = string | PolicyObject;

export interface CompiledPolicy {
  readonly name?: string; // preset or named policy; absent for inline objects
  readonly origin: readonly Origin[]; // never empty; HumanId literals normalised
  readonly rule: readonly Rule[];
  readonly use: readonly Middleware[];
  readonly describe?: string;
  readonly custom: boolean; // any function origin, any rule or any middleware
}

export type PublishedOrigin = "same-human" | "any-human" | "public" | "human" | "custom";
export type PolicyViewOrigin = Exclude<Origin, OriginFn> | "custom";

export interface PublishedPolicy {
  readonly v: 1;
  readonly name?: string;
  readonly origin: readonly PublishedOrigin[];
  readonly custom: boolean;
  readonly describe?: string;
}

export type LogLevel = "error" | "info" | "debug";

export interface HorsContext {
  readonly v: 1;
  readonly fn: string;
  readonly args: unknown;
  readonly argsHash: string;
  readonly callId: string;
  readonly local: boolean;
  readonly transport: string;
  readonly callerAddress: Address | null;
  readonly callerHumanId: HumanId | null;
  readonly callerChainId: string | null;
  readonly ownerHumanId: HumanId | null;
  readonly policy: { readonly name?: string; readonly origin: readonly PolicyViewOrigin[] };
  readonly meta: Readonly<Record<string, unknown>>;
  readonly state: Record<string, unknown>;
  readonly store: Store;
  readonly now: number;
  readonly request: unknown;
  // Written `return ctx.deny(…)` for readability; it throws so the chain unwinds even when the return value is dropped.
  deny(reason: string, opts?: { code?: string; challenge?: unknown }): never;
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
}
