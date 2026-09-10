import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HorsError } from "../src/errors.js";
import { runRules } from "../src/policy/evaluate.js";
import { compilePolicy } from "../src/policy/registry.js";
import type { Rule } from "../src/policy/types.js";
import { makeContext } from "./helpers/context.js";

function expectPolicyError(error: unknown): asserts error is HorsError {
  expect(error).toBeInstanceOf(HorsError);
  expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
  expect((error as HorsError).message).toBe("policy evaluation failed");
}

describe("runRules", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves without touching ctx when there are no rules", async () => {
    const { ctx } = makeContext();
    const seen = ctx.state;
    await runRules(compilePolicy({}), ctx, 10_000);
    expect(ctx.state).toBe(seen);
  });

  it("runs rules in order and stops at the first non-true verdict", async () => {
    const { ctx } = makeContext();
    const first = vi.fn(() => true as const);
    const second = vi.fn(() => true as const);
    await runRules(compilePolicy({ rule: [first, second] }), ctx, 10_000);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0] ?? 0);

    const spy = vi.fn(() => true as const);
    await expect(
      runRules(compilePolicy({ rule: [() => true, () => false, spy] }), ctx, 10_000),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_RULE_DENIED");
      expect((error as HorsError).message).toBe("denied by policy");
      return true;
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("denies with a custom code, reason and challenge, or a generic object deny", async () => {
    const { ctx } = makeContext();
    await expect(
      runRules(
        compilePolicy({
          rule: () => ({ deny: "over budget", code: "OVER_BUDGET", challenge: { pay: 1 } }),
        }),
        ctx,
        10_000,
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("OVER_BUDGET");
      expect((error as HorsError).message).toBe("over budget");
      expect((error as HorsError).data).toEqual({ challenge: { pay: 1 } });
      return true;
    });

    await expect(
      runRules(compilePolicy({ rule: () => ({ deny: "no" }) }), ctx, 10_000),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_RULE_DENIED");
      expect((error as HorsError).message).toBe("no");
      expect((error as HorsError).data).toBeUndefined();
      return true;
    });
  });

  it("keeps ctx.deny custom code and challenge from a rule", async () => {
    const { ctx, logs } = makeContext();
    await expect(
      runRules(
        compilePolicy({
          rule: (c) => c.deny("pay", { code: "OVER_BUDGET", challenge: { price: 1 } }),
        }),
        ctx,
        10_000,
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("OVER_BUDGET");
      expect((error as HorsError).message).toBe("pay");
      expect((error as HorsError).data).toEqual({ challenge: { price: 1 } });
      return true;
    });
    expect(logs).toEqual([]);
  });

  it("wraps a rule-thrown HORS code as HORS_POLICY_ERROR", async () => {
    const { ctx, logs } = makeContext();
    await expect(
      runRules(
        compilePolicy({
          rule: () => {
            throw new HorsError("HORS_UNSIGNED", "x");
          },
        }),
        ctx,
        10_000,
      ),
    ).rejects.toSatisfy((error) => {
      expectPolicyError(error);
      return true;
    });
    expect(logs).toEqual([expect.objectContaining({ level: "error", data: { message: "x" } })]);
  });

  it("rejects reserved or malformed custom codes as HORS_POLICY_ERROR", async () => {
    const { ctx, logs } = makeContext();
    for (const code of ["HORS_X", "lower", "AB", "A".repeat(65)]) {
      logs.length = 0;
      await expect(
        runRules(compilePolicy({ rule: () => ({ deny: "x", code }) }), ctx, 10_000),
      ).rejects.toSatisfy((error) => {
        expectPolicyError(error);
        return true;
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe("error");
    }
  });

  it("rejects verdict shapes that are not true, false, or { deny } and logs each one", async () => {
    const { ctx, logs } = makeContext();
    const verdicts: unknown[] = [{ deny: 1 }, undefined, null, "yes", 1, {}];
    for (const verdict of verdicts) {
      logs.length = 0;
      await expect(
        runRules(compilePolicy({ rule: () => verdict as never }), ctx, 10_000),
      ).rejects.toSatisfy((error) => {
        expectPolicyError(error);
        return true;
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe("error");
    }
  });

  it("wraps a thrown rule as HORS_POLICY_ERROR without echoing the thrown message", async () => {
    const { ctx, logs } = makeContext();
    const thrown = new Error("rule boom");
    await expect(
      runRules(
        compilePolicy({
          rule: () => {
            throw thrown;
          },
        }),
        ctx,
        10_000,
      ),
    ).rejects.toSatisfy((error) => {
      expectPolicyError(error);
      expect(error.cause).toBe(thrown);
      expect(error.message).not.toContain("rule boom");
      return true;
    });
    expect(logs).toEqual([
      expect.objectContaining({ level: "error", data: { message: "rule boom" } }),
    ]);
  });

  it("allows an async rule that settles before the timeout and denies after it", async () => {
    const { ctx } = makeContext();
    const pass: Rule = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(true), 9_999);
      });
    const pendingPass = runRules(compilePolicy({ rule: pass }), ctx, 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    await pendingPass;
    expect(vi.getTimerCount()).toBe(0);

    const late: Rule = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(true), 10_001);
      });
    const pendingLate = runRules(compilePolicy({ rule: late }), ctx, 10_000);
    const lateRejected = expect(pendingLate).rejects.toSatisfy((error) => {
      expectPolicyError(error);
      return true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await lateRejected;

    const hung: Rule = () => new Promise(() => undefined);
    const pendingHung = runRules(compilePolicy({ rule: hung }), ctx, 10_000);
    const hungRejected = expect(pendingHung).rejects.toSatisfy((error) => {
      expectPolicyError(error);
      return true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await hungRejected;
  });

  it("handles a synchronous throw and a synchronous false like the async forms", async () => {
    const { ctx } = makeContext();
    await expect(
      runRules(
        compilePolicy({
          rule: () => {
            throw new Error("sync");
          },
        }),
        ctx,
        10_000,
      ),
    ).rejects.toSatisfy((error) => {
      expectPolicyError(error);
      return true;
    });
    await expect(runRules(compilePolicy({ rule: () => false }), ctx, 10_000)).rejects.toSatisfy(
      (error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("HORS_RULE_DENIED");
        expect((error as HorsError).message).toBe("denied by policy");
        return true;
      },
    );
  });

  it("rejects an empty deny string as HORS_POLICY_ERROR", async () => {
    const { ctx, logs } = makeContext();
    await expect(
      runRules(compilePolicy({ rule: () => ({ deny: "" }) }), ctx, 10_000),
    ).rejects.toSatisfy((error) => {
      expectPolicyError(error);
      return true;
    });
    expect(logs).toHaveLength(1);
  });

  it("omits data when challenge is explicitly undefined", async () => {
    const { ctx } = makeContext();
    await expect(
      runRules(compilePolicy({ rule: () => ({ deny: "x", challenge: undefined }) }), ctx, 10_000),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_RULE_DENIED");
      expect((error as HorsError).data).toBeUndefined();
      return true;
    });
  });

  it("still denies on timeout when the logger throws", async () => {
    const { ctx } = makeContext({
      log: () => {
        throw new Error("logger boom");
      },
    });
    const stray: unknown[] = [];
    const onStray = (reason: unknown) => {
      stray.push(reason);
    };
    process.once("unhandledRejection", onStray);
    process.once("uncaughtException", onStray);
    try {
      const pending = runRules(
        compilePolicy({ rule: () => new Promise(() => undefined) }),
        ctx,
        10_000,
      );
      const rejected = expect(pending).rejects.toSatisfy((error) => {
        expectPolicyError(error);
        return true;
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(stray).toEqual([]);
    } finally {
      process.off("unhandledRejection", onStray);
      process.off("uncaughtException", onStray);
    }
  });

  it("shares ctx.state between rules on the same ctx identity", async () => {
    const { ctx } = makeContext();
    const first: Rule = (c) => {
      c.state.n = 1;
      return true;
    };
    const second: Rule = (c) => {
      expect(c).toBe(ctx);
      expect(c.state.n).toBe(1);
      return true;
    };
    await runRules(compilePolicy({ rule: [first, second] }), ctx, 10_000);
  });
});
