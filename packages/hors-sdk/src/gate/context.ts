import { badEnvelope, denial, isCustomCode } from "../errors.js";
import type { Address, HumanId } from "../identity.js";
import { isPlainObject } from "../plain.js";
import { policyView } from "../policy/compile.js";
import type { CompiledPolicy, HorsContext, LogLevel } from "../policy/types.js";
import type { Store } from "../store.js";
import type { Logger } from "./logger.js";

export const META_MAX_BYTES = 65_536;
const encoder = new TextEncoder();

export interface ContextInput {
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
  readonly policy: CompiledPolicy;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly store: Store;
  readonly now: number;
  readonly request: unknown;
  readonly log: Logger;
}

export function validateMeta(meta: unknown): Readonly<Record<string, unknown>> {
  if (meta === undefined) {
    return Object.freeze({});
  }
  if (!isPlainObject(meta)) {
    badEnvelope("hors/meta must be a JSON object");
  }
  const copy = { ...meta };
  if (Object.hasOwn(copy, "toJSON") && typeof copy.toJSON === "function") {
    badEnvelope("hors/meta must not define toJSON");
  }
  let json: string;
  try {
    json = JSON.stringify(copy);
  } catch {
    badEnvelope("hors/meta is not JSON");
  }
  if (encoder.encode(json).byteLength > META_MAX_BYTES) {
    badEnvelope("hors/meta exceeds 64 KiB");
  }
  return Object.freeze(copy);
}

function prefixedStore(store: Store, prefix: string): Store {
  return {
    get: (key) => store.get(`${prefix}${key}`),
    set: (key, value, ttlMs) => store.set(`${prefix}${key}`, value, ttlMs),
    incr: (key, ttlMs) => store.incr(`${prefix}${key}`, ttlMs),
    consumeOnce: (key, ttlMs) => store.consumeOnce(`${prefix}${key}`, ttlMs),
    delete: (key) => store.delete(`${prefix}${key}`),
  };
}

export function buildContext(input: ContextInput): HorsContext {
  const view = policyView(input.policy);
  const policy = Object.freeze({
    ...view,
    origin: Object.freeze([...view.origin]),
  });
  const { callId, fn } = input;
  const state: Record<string, unknown> = Object.create(null);
  const ctx: HorsContext = {
    v: 1,
    fn,
    args: input.args,
    argsHash: input.argsHash,
    callId,
    local: input.local,
    transport: input.transport,
    callerAddress: input.callerAddress,
    callerHumanId: input.callerHumanId,
    callerChainId: input.callerChainId,
    ownerHumanId: input.ownerHumanId,
    policy,
    meta: input.meta,
    state,
    store: prefixedStore(input.store, "p:"),
    now: input.now,
    request: input.request,
    log(level: LogLevel, message: string, data?: Record<string, unknown>) {
      input.log(level, message, { ...data, callId, fn });
    },
    deny(reason, opts?) {
      if (
        typeof reason !== "string" ||
        reason === "" ||
        (opts?.code !== undefined && !isCustomCode(opts.code))
      ) {
        ctx.log("error", "invalid ctx.deny call", { reason: typeof reason, code: opts?.code });
        throw denial("HORS_POLICY_ERROR", "policy evaluation failed");
      }
      throw denial(opts?.code ?? "HORS_RULE_DENIED", reason, opts?.challenge);
    },
  };
  return Object.freeze(ctx);
}
