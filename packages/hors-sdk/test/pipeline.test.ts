import { describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/config/schema.js";
import { denial, HorsError } from "../src/errors.js";
import { evaluate } from "../src/gate/pipeline.js";
import { normalizeAddress } from "../src/identity.js";
import { compilePolicy } from "../src/policy/registry.js";
import type { Middleware } from "../src/policy/types.js";
import { MemoryStore } from "../src/store.js";
import { MockAgentBook } from "../src/world/mock.js";
import { ADDR_A, HUMAN_A, HUMAN_B } from "./helpers/context.js";
import { evalInput, fixedOwner, makeDeps, WORK_URL } from "./helpers/pipeline.js";
import { DEFAULT_ARGS_HASH, DEFAULT_FN, signedEnvelope, testAccount } from "./helpers/sign.js";

function expectDenial(decision: Awaited<ReturnType<typeof evaluate>>, code: string): void {
  expect(decision.ok).toBe(false);
  if (decision.ok) {
    expect.unreachable();
  }
  expect(decision.denial.code).toBe(code);
}

describe("evaluate pipeline", () => {
  it("handles a local same-human call without touching store or AgentBook", async () => {
    const { deps, store, agentBook, events } = makeDeps({ owner: fixedOwner(null) });
    const lookup = vi.spyOn(agentBook, "lookupHuman");
    const decision = await evaluate(evalInput({ local: true, transport: "mcp-stdio" }), deps);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      expect.unreachable();
    }
    expect(decision.ctx.local).toBe(true);
    expect(decision.ctx.callerHumanId).toBeNull();
    expect(decision.ctx.callerAddress).toBe(ADDR_A);
    expect(decision.ctx.callId).toBe("00000000-0000-4000-8000-000000000001");
    expect(store.size).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(decision.result).toEqual({
      v: 1,
      status: "ok",
      policy: "same-human",
      local: true,
      mock: true,
    });
    expect(decision.value).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("ok");

    const owned = makeDeps({ owner: fixedOwner(HUMAN_A) });
    const withOwner = await evaluate(evalInput({ local: true }), owned.deps);
    expect(withOwner.ok && withOwner.ctx.callerHumanId).toBe(HUMAN_A);

    const mismatch = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({ origin: HUMAN_B }),
      }),
      makeDeps({ owner: fixedOwner(HUMAN_A) }).deps,
    );
    expectDenial(mismatch, "HORS_ORIGIN_MISMATCH");
  });

  it("denies local calls when local is deny", async () => {
    const { deps, store, agentBook, events } = makeDeps({
      settings: () =>
        validateConfig(
          { local: "deny", dev: { mockOrigin: true }, origins: ["https://work.example.com/mcp"] },
          { nodeEnv: undefined },
        ),
    });
    const lookup = vi.spyOn(agentBook, "lookupHuman");
    const decision = await evaluate(evalInput({ local: true }), deps);
    expectDenial(decision, "HORS_LOCAL_DISABLED");
    if (decision.ok) {
      expect.unreachable();
    }
    expect(decision.denial.status).toBe(403);
    expect(store.size).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(events[0]?.status).toBe("deny");
  });

  it("accepts a remote signed same-human call and records duration", async () => {
    const account = testAccount();
    const owner = MockAgentBook.humanIdOf(normalizeAddress(account.address));
    const start = 5_000;
    let reads = 0;
    const { deps, events } = makeDeps({
      owner: fixedOwner(owner),
      now: () => (reads++ === 0 ? start : start + 250),
    });
    const { raw } = await signedEnvelope(account, { argsHash: DEFAULT_ARGS_HASH, now: start });
    const decision = await evaluate(evalInput({ envelope: raw, url: WORK_URL }), deps);
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      expect.unreachable();
    }
    expect(decision.ctx.callerAddress).toBe(normalizeAddress(account.address));
    expect(decision.ctx.callerChainId).toBe("eip155:480");
    expect(decision.ctx.callId).toBe((raw.requestId as string) ?? "");
    expect(decision.ctx.now).toBe(start);
    expect(events[0]).toMatchObject({
      callId: raw.requestId,
      callerAddress: normalizeAddress(account.address),
      callerHumanId: owner,
      status: "ok",
      policy: "same-human",
      durationMs: 250,
    });
  });

  it("denies a remote signed call from another wallet", async () => {
    const account = testAccount();
    const { deps, events, clock } = makeDeps();
    const { raw } = await signedEnvelope(account, { now: clock.now });
    const decision = await evaluate(evalInput({ envelope: raw, url: WORK_URL }), deps);
    expectDenial(decision, "HORS_ORIGIN_MISMATCH");
    if (decision.ok) {
      expect.unreachable();
    }
    expect(decision.denial.text).toBe(
      "HORS_ORIGIN_MISMATCH: caller does not match the function's origin",
    );
    expect(events[0]?.code).toBe("HORS_ORIGIN_MISMATCH");
  });

  it("treats an unsigned public call as anonymous and unsigned same-human as 401", async () => {
    const pub = await evaluate(evalInput({ policy: compilePolicy("public") }), makeDeps().deps);
    expect(pub.ok).toBe(true);
    if (!pub.ok) {
      expect.unreachable();
    }
    expect(pub.ctx.callerAddress).toBeNull();
    expect(pub.ctx.callerHumanId).toBeNull();
    expect(pub.ctx.callerChainId).toBeNull();
    expect(pub.ctx.callId).toBe("00000000-0000-4000-8000-000000000001");

    const denied = await evaluate(evalInput({}), makeDeps().deps);
    expectDenial(denied, "HORS_UNSIGNED");
    if (denied.ok) {
      expect.unreachable();
    }
    expect(denied.denial.status).toBe(401);
  });

  it("denies same-human remote signed calls while the owner is unresolved", async () => {
    const account = testAccount();
    const { deps, clock } = makeDeps({ owner: fixedOwner(null) });
    const { raw } = await signedEnvelope(account, { now: clock.now });
    const decision = await evaluate(evalInput({ envelope: raw, url: WORK_URL }), deps);
    expectDenial(decision, "HORS_OWNER_UNRESOLVED");
    if (decision.ok) {
      expect.unreachable();
    }
    expect(decision.denial.status).toBe(503);
  });

  it("derives the expected URL from the request when origins are absent", async () => {
    const account = testAccount();
    const owner = MockAgentBook.humanIdOf(normalizeAddress(account.address));
    const settings = () => validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined });
    const { raw } = await signedEnvelope(account, {
      now: Date.parse("2026-09-08T02:15:30.123Z"),
    });
    const missing = await evaluate(
      evalInput({ envelope: raw }),
      makeDeps({ owner: fixedOwner(owner), settings }).deps,
    );
    expectDenial(missing, "HORS_DOMAIN_MISMATCH");
    const ok = await evaluate(
      evalInput({ envelope: raw, url: WORK_URL }),
      makeDeps({ owner: fixedOwner(owner), settings }).deps,
    );
    expect(ok.ok).toBe(true);
  });

  it("validates hors/meta before identity work", async () => {
    const account = testAccount();
    const { deps, store, agentBook } = makeDeps();
    const lookup = vi.spyOn(agentBook, "lookupHuman");
    const { raw } = await signedEnvelope(account);
    const decision = await evaluate(
      evalInput({ envelope: raw, url: WORK_URL, meta: { k: "a".repeat(70_000) } }),
      deps,
    );
    expectDenial(decision, "HORS_BAD_ENVELOPE");
    expect(store.size).toBe(0);
    expect(lookup).not.toHaveBeenCalled();

    const withMeta = await evaluate(
      evalInput({ local: true, meta: { proof: 1 } }),
      makeDeps().deps,
    );
    expect(withMeta.ok && withMeta.ctx.meta).toEqual({ proof: 1 });
    expect(withMeta.ok && Object.isFrozen(withMeta.ctx.meta)).toBe(true);
  });

  it("resolves policy in registration, functions, then default order", async () => {
    const settings = () =>
      validateConfig(
        {
          policy: "same-human",
          functions: { [DEFAULT_FN]: "any-human" },
          dev: { mockOrigin: true },
          origins: ["https://work.example.com/mcp"],
        },
        { nodeEnv: undefined },
      );
    const { deps } = makeDeps({ settings });
    const inline = await evaluate(
      evalInput({ local: true, policy: compilePolicy("public") }),
      deps,
    );
    expect(inline.ok && inline.ctx.policy.name).toBe("public");
    const fromFn = await evaluate(evalInput({ local: true }), deps);
    expect(fromFn.ok && fromFn.ctx.policy.name).toBe("any-human");
    const fallback = await evaluate(evalInput({ local: true, fn: "other" }), deps);
    expect(fallback.ok && fallback.ctx.policy.name).toBe("same-human");
  });

  it("runs middleware in registration order around the handler", async () => {
    const { deps } = makeDeps();
    let seenCtx: unknown;
    const value = { content: [] };
    const written = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          rule: (ctx) => {
            ctx.state.seen = true;
            return true;
          },
        }),
        handler: (ctx) => {
          seenCtx = ctx;
          expect(ctx.state.seen).toBe(true);
          return value;
        },
      }),
      deps,
    );
    expect(written.ok && written.value).toBe(value);
    expect(written.ok && written.ctx).toBe(seenCtx);

    const a: Middleware = async (ctx, next) => {
      ctx.state.order = ["a"];
      return next();
    };
    const b: Middleware = async (ctx, next) => {
      (ctx.state.order as string[]).push("b");
      return next();
    };
    const ordered = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({ origin: "public", use: [a, b] }),
        handler: (ctx) => {
          (ctx.state.order as string[]).push("h");
          return ctx.state.order;
        },
      }),
      makeDeps().deps,
    );
    expect(ordered.ok && ordered.value).toEqual(["a", "b", "h"]);
  });

  it("keeps a middleware ctx.deny custom code and challenge", async () => {
    const handler = vi.fn(async () => "ran");
    const { deps, events } = makeDeps();
    const denied = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          use: async (ctx) => ctx.deny("no", { code: "OVER_BUDGET", challenge: { pay: 1 } }),
        }),
        handler,
      }),
      deps,
    );
    expectDenial(denied, "OVER_BUDGET");
    if (denied.ok) {
      expect.unreachable();
    }
    expect(denied.denial.challenge).toEqual({ pay: 1 });
    expect(denied.denial.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(events[0]?.code).toBe("OVER_BUDGET");
  });

  it("converts a throwing middleware into HORS_POLICY_ERROR", async () => {
    const handler = vi.fn(async () => "ran");
    const broken = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          use: async () => {
            throw new Error("mw");
          },
        }),
        handler,
      }),
      makeDeps().deps,
    );
    expectDenial(broken, "HORS_POLICY_ERROR");
    if (broken.ok) {
      expect.unreachable();
    }
    expect(broken.denial.status).toBe(500);
  });

  it("propagates a handler exception with an ok audit", async () => {
    const db = new Error("db");
    const { deps, events } = makeDeps();
    await expect(
      evaluate(
        evalInput({
          local: true,
          policy: compilePolicy("public"),
          handler: () => {
            throw db;
          },
        }),
        deps,
      ),
    ).rejects.toBe(db);
    expect(events).toEqual([expect.objectContaining({ status: "ok" })]);
  });

  it("denies a rule challenge with HORS_RULE_DENIED", async () => {
    const challenged = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          rule: () => ({ deny: "over", challenge: { pay: 2 } }),
        }),
      }),
      makeDeps().deps,
    );
    expectDenial(challenged, "HORS_RULE_DENIED");
    if (challenged.ok) {
      expect.unreachable();
    }
    expect(challenged.denial.challenge).toEqual({ pay: 2 });
  });

  it("swaps settings between calls and maps a store failure", async () => {
    const account = testAccount();
    const owner = MockAgentBook.humanIdOf(normalizeAddress(account.address));
    const issued = Date.parse("2026-09-08T02:15:30.123Z");
    const firstEnv = await signedEnvelope(account, { now: issued });
    const secondEnv = await signedEnvelope(account, { now: issued });
    let current = validateConfig(
      { dev: { mockOrigin: true }, origins: ["https://work.example.com/mcp"] },
      { nodeEnv: undefined },
    );
    const { deps } = makeDeps({ owner: fixedOwner(owner), settings: () => current });
    const first = await evaluate(evalInput({ envelope: firstEnv.raw, url: WORK_URL }), deps);
    expect(first.ok).toBe(true);
    current = validateConfig(
      {
        deny: [account.address],
        dev: { mockOrigin: true },
        origins: ["https://work.example.com/mcp"],
      },
      { nodeEnv: undefined },
    );
    const second = await evaluate(evalInput({ envelope: secondEnv.raw, url: WORK_URL }), deps);
    expectDenial(second, "HORS_DENIED_WALLET");

    const store = new MemoryStore();
    store.consumeOnce = async () => {
      throw new Error("down");
    };
    const unavailable = await evaluate(
      evalInput({
        envelope: (await signedEnvelope(account, { now: issued })).raw,
        url: WORK_URL,
      }),
      makeDeps({ owner: fixedOwner(owner), store }).deps,
    );
    expectDenial(unavailable, "HORS_UNAVAILABLE");
    if (unavailable.ok) {
      expect.unreachable();
    }
    expect(unavailable.denial.status).toBe(503);
  });

  it("rejects malformed evaluate input without auditing", async () => {
    const { deps, events, logs } = makeDeps();
    for (const input of [
      evalInput({ argsHash: "nope" }),
      evalInput({ fn: "" }),
      evalInput({ transport: "" }),
      evalInput({ local: "true" as never }),
      evalInput({ handler: 1 as never }),
    ]) {
      events.length = 0;
      logs.length = 0;
      await expect(evaluate(input, deps)).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
      expect(events).toEqual([]);
      expect(logs).toEqual([]);
    }
  });

  it("hashes absent argsHash and denials a value that cannot be canonicalised", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { deps, events } = makeDeps();
    const decision = await evaluate(
      evalInput({
        fn: DEFAULT_FN,
        args: cyclic,
        argsHash: undefined,
        transport: "wrap",
        local: true,
      }),
      deps,
    );
    expectDenial(decision, "HORS_BAD_ENVELOPE");
    expect(events).toEqual([
      expect.objectContaining({ status: "deny", code: "HORS_BAD_ENVELOPE" }),
    ]);
  });

  it("clamps a backwards clock and rejects a non-finite one", async () => {
    let now = 1_000;
    const { deps, events } = makeDeps({ now: () => now });
    const first = await evaluate(evalInput({ local: true }), deps);
    expect(first.ok).toBe(true);
    now = 500;
    events.length = 0;
    const second = await evaluate(evalInput({ local: true }), deps);
    expect(second.ok).toBe(true);
    expect(events[0]?.durationMs).toBe(0);

    const nan = makeDeps({ now: () => Number.NaN });
    await expect(evaluate(evalInput({ local: true }), nan.deps)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("CONFIG_INVALID");
      return true;
    });
    expect(nan.events).toEqual([]);
  });

  it("keeps a branded rule or origin deny and wraps an unbranded HORS code", async () => {
    const ruleDeny = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          rule: (ctx) => ctx.deny("pay", { code: "OVER_BUDGET", challenge: { price: 1 } }),
        }),
      }),
      makeDeps().deps,
    );
    expectDenial(ruleDeny, "OVER_BUDGET");
    if (!ruleDeny.ok) {
      expect(ruleDeny.denial.challenge).toEqual({ price: 1 });
    }

    const originDeny = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: (ctx) => ctx.deny("pay", { code: "OVER_BUDGET", challenge: { price: 1 } }),
        }),
      }),
      makeDeps().deps,
    );
    expectDenial(originDeny, "OVER_BUDGET");

    const { deps: ruleThrowDeps, logs: ruleThrowLogs } = makeDeps();
    const ruleThrow = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          rule: () => {
            throw new HorsError("HORS_UNSIGNED", "x");
          },
        }),
      }),
      ruleThrowDeps,
    );
    expectDenial(ruleThrow, "HORS_POLICY_ERROR");
    if (!ruleThrow.ok) {
      expect(ruleThrow.denial.reason).toBe("policy evaluation failed");
    }
    expect(ruleThrowLogs.filter((event) => event.level === "error")).toHaveLength(1);
    expect(ruleThrowLogs.some((event) => event.data?.message === "x")).toBe(true);

    const { deps: mwDeps } = makeDeps();
    const mwThrow = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          use: async () => {
            throw new HorsError("HORS_DOMAIN_MISMATCH", "expected inner.example/mcp");
          },
        }),
        handler: async () => "ok",
      }),
      mwDeps,
    );
    expectDenial(mwThrow, "HORS_POLICY_ERROR");
    if (!mwThrow.ok) {
      expect(mwThrow.denial.reason).not.toContain("inner");
    }

    const nested = new HorsError("HORS_DOMAIN_MISMATCH", "expected inner.example/mcp");
    const { deps: handlerDeps, events: handlerEvents } = makeDeps();
    await expect(
      evaluate(
        evalInput({
          local: true,
          policy: compilePolicy("public"),
          handler: () => {
            throw nested;
          },
        }),
        handlerDeps,
      ),
    ).rejects.toBe(nested);
    expect(handlerEvents).toEqual([expect.objectContaining({ status: "ok" })]);

    const handlerDeny = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy("public"),
        handler: (ctx) => ctx.deny("no", { code: "HANDLER_NO" }),
      }),
      makeDeps().deps,
    );
    expectDenial(handlerDeny, "HANDLER_NO");

    const branded = denial("OVER_BUDGET", "pay", { price: 1 });
    let seen: unknown;
    const rethrown = await evaluate(
      evalInput({
        local: true,
        policy: compilePolicy({
          origin: "public",
          use: async (_ctx, next) => {
            try {
              return await next();
            } catch (error) {
              seen = error;
              throw error;
            }
          },
        }),
        handler: () => {
          throw branded;
        },
      }),
      makeDeps().deps,
    );
    expect(seen).toBe(branded);
    expectDenial(rethrown, "OVER_BUDGET");
    if (!rethrown.ok) {
      expect(rethrown.denial.challenge).toEqual({ price: 1 });
    }
  });

  it("keeps the decision when the audit sink throws", async () => {
    const { deps, logs } = makeDeps({
      audit: () => {
        throw new Error("audit");
      },
    });
    const decision = await evaluate(evalInput({ local: true }), deps);
    expect(decision.ok).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "error", message: "audit sink threw" }),
    );
  });
});
