import { ARGS_HASH } from "../binding.js";
import type { GateConfig } from "../config/schema.js";
import { HorsError, isPolicyDenial } from "../errors.js";
import { hashArgs } from "../hash.js";
import type { Address, HumanId } from "../identity.js";
import { checkOrigin, runMiddleware, runRules } from "../policy/evaluate.js";
import type { CompiledPolicy, HorsContext, HorsResult } from "../policy/types.js";
import type { Store } from "../store.js";
import { expectedUrls, type RequestLocation } from "../verify/expected-url.js";
import type { SignatureVerifier } from "../verify/signature.js";
import { verifyCaller } from "../verify/verify.js";
import type { AgentBook } from "../world/agentbook.js";
import type { AuditEvent } from "./audit.js";
import { buildContext, validateMeta } from "./context.js";
import type { Logger } from "./logger.js";
import type { OwnerResolver } from "./owner.js";
import { type Denial, denialFrom, type HorsResultMeta, okResult } from "./result.js";

const NO_LOCATION: RequestLocation = {
  host: undefined,
  forwardedHost: undefined,
  path: "/",
};

export interface EvaluateInput {
  readonly fn: string; // function identifier: the tool name, or "METHOD /path" for HTTP
  readonly argsHash?: string; // 64 lowercase hex; absent → hashArgs(args ?? {}) inside the pipeline
  readonly args?: unknown; // ctx.args; undefined when the adapter has none (HTTP non-JSON body)
  readonly envelope?: unknown; // _meta["hors/auth"] / HORS-Auth as received; undefined when absent
  readonly meta?: unknown; // _meta["hors/meta"] as received; undefined when absent
  readonly transport: string; // "mcp-stdio" | "mcp-http" | "http" | "wrap" | adapter-chosen
  readonly local: boolean; // local vs remote is the adapter's decision; the pipeline trusts it
  readonly request?: unknown; // ctx.request
  readonly url?: RequestLocation; // remote calls: what the expected URL is derived from
  readonly policy?: CompiledPolicy; // compiled by the caller at registration time
  readonly handler?: (ctx: HorsContext) => HorsResult | Promise<HorsResult>; // step 8; absent → stop after step 7
}

export type Decision =
  | {
      readonly ok: true;
      readonly ctx: HorsContext;
      readonly result: HorsResultMeta; // status "ok"
      readonly value: HorsResult; // the handler's return value; undefined when no handler was given
    }
  | { readonly ok: false; readonly denial: Denial };

export interface PipelineDeps {
  readonly settings: () => GateConfig; // read once per call
  readonly store: Store;
  readonly agentBook: AgentBook;
  readonly signatureVerifier: (chainId: string) => SignatureVerifier | undefined;
  readonly owner: OwnerResolver;
  readonly address: Address | null; // the gate's wallet (callerAddress for local calls)
  readonly log: Logger;
  readonly audit: (event: AuditEvent) => void;
  readonly now: () => number; // Date.now in production
  readonly uuid: () => string; // crypto.randomUUID in production
}

interface ResolvedCaller {
  readonly address: Address | null;
  readonly humanId: HumanId | null;
  readonly chainId: string | null;
  readonly callId: string;
}

function invalidInput(detail: string): never {
  throw new HorsError("CONFIG_INVALID", `evaluate: ${detail}`);
}

function assertEvaluateInput(input: EvaluateInput): void {
  if (typeof input.fn !== "string" || input.fn === "") {
    invalidInput("fn must be a non-empty string");
  }
  if (
    input.argsHash !== undefined &&
    (typeof input.argsHash !== "string" || !ARGS_HASH.test(input.argsHash))
  ) {
    invalidInput("argsHash must be 64 lowercase hex characters");
  }
  if (typeof input.transport !== "string" || input.transport === "") {
    invalidInput("transport must be a non-empty string");
  }
  if (typeof input.local !== "boolean") {
    invalidInput("local must be a boolean");
  }
  if (input.handler !== undefined && typeof input.handler !== "function") {
    invalidInput("handler must be a function");
  }
}

export async function evaluate(input: EvaluateInput, deps: PipelineDeps): Promise<Decision> {
  assertEvaluateInput(input);

  const started = deps.now();
  if (!Number.isFinite(started)) {
    invalidInput("clock returned a non-finite time");
  }
  const settings = deps.settings();
  const policy = input.policy ?? settings.functions.get(input.fn) ?? settings.policy;
  const generatedId = deps.uuid();
  const local = input.local;
  let callId = generatedId;
  let callerAddress: Address | null = null;
  let callerHumanId: HumanId | null = null;
  let handlerError: { readonly error: unknown } | undefined;

  const emit = (status: "ok" | "deny", code?: string) => {
    const event: AuditEvent = {
      v: 1,
      at: started,
      fn: input.fn,
      callId,
      transport: input.transport,
      local,
      callerAddress,
      callerHumanId,
      status,
      durationMs: Math.max(0, deps.now() - started),
      ...(code === undefined ? {} : { code }),
      ...(policy.name === undefined ? {} : { policy: policy.name }),
    };
    try {
      deps.audit(event);
    } catch {
      deps.log("error", "audit sink threw");
    }
  };

  try {
    // Validate hors/meta first: a cheap reject before any hashing or RPC.
    const meta = validateMeta(input.meta);
    // Arguments hash and owner.
    const argsHash = input.argsHash ?? (await hashArgs(input.args ?? {}));
    const owner = deps.owner.current() ?? (await deps.owner.resolve(started));

    let caller: ResolvedCaller;
    if (local) {
      // Local call: the gate's own wallet is the caller.
      if (settings.local === "deny") {
        throw new HorsError("HORS_LOCAL_DISABLED", "local calls are disabled");
      }
      caller = { address: deps.address, humanId: owner, chainId: null, callId: generatedId };
    } else {
      // Remote call: verify the envelope.
      const expected =
        input.envelope === undefined
          ? []
          : expectedUrls(input.url ?? NO_LOCATION, {
              trustProxy: settings.trustProxy,
              origins: settings.origins,
            });
      const verified = await verifyCaller(
        {
          auth: input.envelope,
          fn: input.fn,
          argsHash,
          expected,
          publicOrigin: policy.origin.includes("public"),
          now: started,
        },
        {
          store: deps.store,
          agentBook: deps.agentBook,
          deny: settings.deny,
          signatureVerifier: deps.signatureVerifier,
          maxAgeMs: settings.maxAgeMs,
          clockSkewMs: settings.clockSkewMs,
        },
      );
      caller =
        verified.kind === "anonymous"
          ? { address: null, humanId: null, chainId: null, callId: generatedId }
          : {
              address: verified.address,
              humanId: verified.humanId,
              chainId: verified.chainId,
              callId: verified.callId,
            };
    }
    callId = caller.callId;
    callerAddress = caller.address;
    callerHumanId = caller.humanId;

    // Build the policy context.
    const ctx = buildContext({
      fn: input.fn,
      args: input.args,
      argsHash,
      callId: caller.callId,
      local,
      transport: input.transport,
      callerAddress: caller.address,
      callerHumanId: caller.humanId,
      callerChainId: caller.chainId,
      ownerHumanId: owner,
      policy,
      meta,
      store: deps.store,
      now: started,
      request: input.request,
      log: deps.log,
    });
    // Origin, then rules.
    await checkOrigin(policy, ctx, settings.ruleTimeoutMs);
    await runRules(policy, ctx, settings.ruleTimeoutMs);

    let value: unknown;
    if (input.handler !== undefined) {
      try {
        // Middleware around the handler.
        const handler = input.handler;
        value = await runMiddleware(policy, ctx, () => Promise.resolve(handler(ctx)));
      } catch (error) {
        if (isPolicyDenial(error)) {
          throw error;
        }
        handlerError = { error };
        emit("ok");
        throw error;
      }
    }
    // Success result.
    const result = okResult(policy, local, settings.mock);
    emit("ok");
    return { ok: true, ctx, result, value };
  } catch (error) {
    if (handlerError !== undefined && error === handlerError.error) {
      throw error;
    }
    const denial = denialFrom(error, {
      policy,
      local,
      mock: settings.mock,
      log: deps.log,
    });
    emit("deny", denial.code);
    return { ok: false, denial };
  }
}
