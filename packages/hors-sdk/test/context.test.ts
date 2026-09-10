import { describe, expect, it } from "vitest";
import { HorsError } from "../src/errors.js";
import { buildContext, META_MAX_BYTES, validateMeta } from "../src/gate/context.js";
import { normalizeHumanId } from "../src/identity.js";
import { compilePolicy } from "../src/policy/registry.js";
import { MemoryStore } from "../src/store.js";
import { ADDR_A, HUMAN_A } from "./helpers/context.js";
import { memoryLogger } from "./helpers/logger.js";

function expectBadMeta(meta: unknown, snippet: string): void {
  try {
    validateMeta(meta);
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
    expect((error as HorsError).message).toContain(snippet);
    return;
  }
  expect.unreachable();
}

describe("validateMeta and buildContext", () => {
  it("accepts undefined and rejects non-objects (K1)", () => {
    const empty = validateMeta(undefined);
    expect(empty).toEqual({});
    expect(Object.isFrozen(empty)).toBe(true);
    expectBadMeta([], "hors/meta must be a JSON object");
    expectBadMeta(null, "hors/meta must be a JSON object");
    expectBadMeta("x", "hors/meta must be a JSON object");
    expectBadMeta(new (class {})(), "hors/meta must be a JSON object");
    expectBadMeta(Object.create(null), "hors/meta must be a JSON object");
    expectBadMeta({ n: 1n }, "hors/meta is not JSON");
  });

  it("counts UTF-8 bytes of JSON.stringify, not JS string length (K1)", () => {
    const overhead = JSON.stringify({ k: "" }).length;
    const exact = validateMeta({ k: "a".repeat(META_MAX_BYTES - overhead) });
    expect(Object.isFrozen(exact)).toBe(true);
    expectBadMeta({ k: "a".repeat(META_MAX_BYTES - overhead + 1) }, "hors/meta exceeds 64 KiB");
    const euros = { k: "€".repeat(21_846) };
    expect(JSON.stringify(euros).length).toBeLessThan(META_MAX_BYTES);
    expectBadMeta(euros, "hors/meta exceeds 64 KiB");
    const source = { proof: 1 };
    const copy = validateMeta(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(Object.isFrozen(copy)).toBe(true);
  });

  it("rejects an own toJSON and snapshots getters before measuring", () => {
    expectBadMeta(
      {
        toJSON() {
          return { k: "a".repeat(70_000) };
        },
      },
      "hors/meta must not define toJSON",
    );
    let reads = 0;
    const shapeshifting = {
      get k() {
        reads += 1;
        return reads === 1 ? "a" : "a".repeat(70_000);
      },
    };
    const copy = validateMeta(shapeshifting);
    expect(copy).toEqual({ k: "a" });
    expect(reads).toBe(1);
  });

  it("freezes the context, prefixes the store and scopes the logger (K2–K5)", async () => {
    const store = new MemoryStore();
    const { log, events } = memoryLogger();
    const human = normalizeHumanId("0xABC");
    const ctx = buildContext({
      fn: "approveTravelExpense",
      args: { n: 1 },
      argsHash: "f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab",
      callId: "call-1",
      local: false,
      transport: "test",
      callerAddress: ADDR_A,
      callerHumanId: HUMAN_A,
      callerChainId: "eip155:480",
      ownerHumanId: HUMAN_A,
      policy: compilePolicy({ origin: [human, () => true] }),
      meta: { proof: 1 },
      store,
      now: 1,
      request: undefined,
      log,
    });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.policy)).toBe(true);
    expect(Object.isFrozen(ctx.policy.origin)).toBe(true);
    expect(Object.getPrototypeOf(ctx.state)).toBe(null);
    expect("constructor" in ctx.state).toBe(false);
    ctx.state.x = 1;
    expect(ctx.state.x).toBe(1);
    expect(ctx.policy.origin).toEqual([human, "custom"]);
    await ctx.store.set("k", 1);
    expect(await store.get("p:k")).toBe(1);
    expect(await store.get("k")).toBeUndefined();
    await ctx.store.incr("n");
    expect(await store.get("p:n")).toBe(1);
    expect(await ctx.store.consumeOnce("once", 1000)).toBe(true);
    expect(await store.consumeOnce("p:once", 1000)).toBe(false);
    ctx.log("info", "m", { a: 1, fn: "spoof" });
    expect(events[0]).toEqual({
      level: "info",
      message: "m",
      data: { a: 1, fn: "approveTravelExpense", callId: "call-1" },
    });

    try {
      ctx.deny("x");
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_RULE_DENIED");
      expect((error as HorsError).message).toBe("x");
      expect((error as HorsError).data).toBeUndefined();
    }
    try {
      ctx.deny("x", { code: "OVER_BUDGET", challenge: { pay: 1 } });
    } catch (error) {
      expect((error as HorsError).code).toBe("OVER_BUDGET");
      expect((error as HorsError).data).toEqual({ challenge: { pay: 1 } });
    }
    events.length = 0;
    for (const deny of [
      () => ctx.deny(""),
      () => ctx.deny("x", { code: "HORS_UNSIGNED" }),
      () => ctx.deny("x", { code: "lower" }),
    ]) {
      try {
        deny();
      } catch (error) {
        expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      }
    }
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.message === "invalid ctx.deny call")).toBe(true);
  });
});
