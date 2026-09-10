import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HorsError } from "../src/errors.js";
import type { HumanId } from "../src/identity.js";
import { checkOrigin } from "../src/policy/evaluate.js";
import { compilePolicy } from "../src/policy/registry.js";
import type { Origin } from "../src/policy/types.js";
import type { MemoryStore } from "../src/store.js";
import { HUMAN_A, HUMAN_B, makeContext } from "./helpers/context.js";

const A = HUMAN_A;
const B = HUMAN_B;

type Row = {
  members: Origin[];
  local: boolean;
  callerHumanId: HumanId | null;
  ownerHumanId: HumanId | null;
  expect: "pass" | "HORS_ORIGIN_MISMATCH" | "HORS_OWNER_UNRESOLVED";
  callerAddressNull?: boolean;
};

const rows: Row[] = [
  { members: ["same-human"], local: false, callerHumanId: A, ownerHumanId: A, expect: "pass" },
  {
    members: ["same-human"],
    local: false,
    callerHumanId: B,
    ownerHumanId: A,
    expect: "HORS_ORIGIN_MISMATCH",
  },
  {
    members: ["same-human"],
    local: false,
    callerHumanId: A,
    ownerHumanId: null,
    expect: "HORS_OWNER_UNRESOLVED",
  },
  {
    members: ["same-human"],
    local: false,
    callerHumanId: null,
    ownerHumanId: null,
    expect: "HORS_OWNER_UNRESOLVED",
  },
  {
    members: ["same-human"],
    local: false,
    callerHumanId: null,
    ownerHumanId: A,
    expect: "HORS_ORIGIN_MISMATCH",
  },
  { members: ["same-human"], local: true, callerHumanId: null, ownerHumanId: null, expect: "pass" },
  { members: ["same-human"], local: true, callerHumanId: A, ownerHumanId: A, expect: "pass" },
  { members: ["any-human"], local: false, callerHumanId: B, ownerHumanId: A, expect: "pass" },
  {
    members: ["any-human"],
    local: false,
    callerHumanId: null,
    ownerHumanId: A,
    expect: "HORS_ORIGIN_MISMATCH",
  },
  { members: ["any-human"], local: true, callerHumanId: null, ownerHumanId: null, expect: "pass" },
  {
    members: ["public"],
    local: false,
    callerHumanId: null,
    ownerHumanId: A,
    expect: "pass",
    callerAddressNull: true,
  },
  { members: ["public"], local: false, callerHumanId: B, ownerHumanId: A, expect: "pass" },
  { members: [A], local: false, callerHumanId: A, ownerHumanId: B, expect: "pass" },
  { members: [A], local: false, callerHumanId: B, ownerHumanId: A, expect: "HORS_ORIGIN_MISMATCH" },
  {
    members: [A],
    local: true,
    callerHumanId: null,
    ownerHumanId: null,
    expect: "HORS_ORIGIN_MISMATCH",
  },
  { members: [A], local: true, callerHumanId: A, ownerHumanId: A, expect: "pass" },
  {
    members: ["same-human", B],
    local: false,
    callerHumanId: B,
    ownerHumanId: null,
    expect: "pass",
  },
  {
    members: ["same-human", "public"],
    local: false,
    callerHumanId: null,
    ownerHumanId: null,
    expect: "pass",
  },
  {
    members: ["same-human", () => false],
    local: false,
    callerHumanId: B,
    ownerHumanId: null,
    expect: "HORS_OWNER_UNRESOLVED",
  },
  {
    members: ["same-human", () => false],
    local: false,
    callerHumanId: B,
    ownerHumanId: A,
    expect: "HORS_ORIGIN_MISMATCH",
  },
];

describe("checkOrigin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(rows)(
    "members=$members local=$local caller=$callerHumanId owner=$ownerHumanId → $expect",
    async (row) => {
      const { ctx } = makeContext({
        local: row.local,
        callerHumanId: row.callerHumanId,
        ownerHumanId: row.ownerHumanId,
        ...(row.callerAddressNull ? { callerAddress: null } : {}),
      });
      const policy = compilePolicy({ origin: row.members });
      if (row.expect === "pass") {
        await expect(checkOrigin(policy, ctx, 10_000)).resolves.toBeUndefined();
      } else {
        await expect(checkOrigin(policy, ctx, 10_000)).rejects.toSatisfy((error) => {
          expect(error).toBeInstanceOf(HorsError);
          expect((error as HorsError).code).toBe(row.expect);
          return true;
        });
      }
      expect((ctx.store as MemoryStore).size).toBe(0);
    },
  );

  it("calls a function origin with the same ctx and passes on exactly true", async () => {
    const { ctx } = makeContext();
    const fn = vi.fn(async () => true);
    await checkOrigin(compilePolicy({ origin: fn }), ctx, 10_000);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith(ctx);
    expect(vi.getTimerCount()).toBe(0);
    expect((ctx.store as MemoryStore).size).toBe(0);
  });

  it("evaluates literals before function members and stops at the first match", async () => {
    const { ctx } = makeContext();
    const fn = vi.fn(async () => true);
    await checkOrigin(compilePolicy({ origin: [fn, "any-human"] }), ctx, 10_000);
    expect(fn).not.toHaveBeenCalled();

    const publicFn = vi.fn(() => true);
    await checkOrigin(compilePolicy({ origin: ["public", publicFn] }), ctx, 10_000);
    expect(publicFn).not.toHaveBeenCalled();
  });

  it("evaluates function members in order and skips later ones after a match", async () => {
    const { ctx } = makeContext();
    const fnFalse = vi.fn(() => false);
    const fnTrue = vi.fn(() => true);
    await checkOrigin(compilePolicy({ origin: [fnFalse, fnTrue] }), ctx, 10_000);
    expect(fnFalse).toHaveBeenCalledOnce();
    expect(fnTrue).toHaveBeenCalledOnce();
    expect(fnFalse.mock.invocationCallOrder[0]).toBeLessThan(
      fnTrue.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("fails closed when a function origin throws and does not evaluate later members", async () => {
    const { ctx, logs } = makeContext();
    const thrown = new Error("origin boom");
    const fnThrows = vi.fn(() => {
      throw thrown;
    });
    const fnTrue = vi.fn(() => true);
    await expect(
      checkOrigin(compilePolicy({ origin: [fnThrows, fnTrue] }), ctx, 10_000),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      expect((error as HorsError).message).toBe("policy evaluation failed");
      expect((error as HorsError).cause).toBe(thrown);
      return true;
    });
    expect(fnTrue).not.toHaveBeenCalled();
    expect(logs).toEqual([
      expect.objectContaining({ level: "error", data: { message: "origin boom" } }),
    ]);
    expect((ctx.store as MemoryStore).size).toBe(0);
  });

  it("treats a non-boolean function origin result as HORS_POLICY_ERROR", async () => {
    for (const value of ["yes", undefined, 1] as const) {
      const { ctx, logs } = makeContext();
      await expect(
        checkOrigin(compilePolicy({ origin: () => value as never }), ctx, 10_000),
      ).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
        return true;
      });
      expect(logs.filter((entry) => entry.level === "error")).toHaveLength(1);
    }
  });

  it("fails closed when callerHumanId is not a humanId", async () => {
    const { ctx } = makeContext({
      local: false,
      callerHumanId: undefined as never,
    });
    await expect(
      checkOrigin(compilePolicy({ origin: "any-human" }), ctx, 10_000),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_ORIGIN_MISMATCH");
      return true;
    });
  });

  it("fails closed when local is not the boolean true", async () => {
    const { ctx } = makeContext({
      local: "true" as never,
      callerHumanId: HUMAN_B,
      ownerHumanId: HUMAN_A,
    });
    await expect(
      checkOrigin(compilePolicy({ origin: "same-human" }), ctx, 10_000),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_ORIGIN_MISMATCH");
      return true;
    });
  });

  it("does not treat two nulls as a matching HumanId origin", async () => {
    const { ctx } = makeContext({
      local: true,
      callerHumanId: null,
      ownerHumanId: null,
    });
    const policy = { ...compilePolicy({ origin: "public" }), origin: [null as never] };
    await expect(checkOrigin(policy, ctx, 10_000)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_ORIGIN_MISMATCH");
      return true;
    });
  });

  it("keeps ctx.deny from an origin function", async () => {
    const { ctx, logs } = makeContext();
    await expect(
      checkOrigin(
        compilePolicy({
          origin: (c) => c.deny("pay", { code: "OVER_BUDGET", challenge: { price: 1 } }),
        }),
        ctx,
        10_000,
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("OVER_BUDGET");
      expect((error as HorsError).data).toEqual({ challenge: { price: 1 } });
      return true;
    });
    expect(logs).toEqual([]);
  });

  it("times out a function origin that never settles", async () => {
    const { ctx } = makeContext();
    const pending = checkOrigin(
      compilePolicy({ origin: () => new Promise<boolean>(() => undefined) }),
      ctx,
      10_000,
    );
    const rejected = expect(pending).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      return true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect((ctx.store as MemoryStore).size).toBe(0);
  });
});
