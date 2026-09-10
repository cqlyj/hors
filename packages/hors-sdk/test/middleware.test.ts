import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { denial, HorsError } from "../src/errors.js";
import { runMiddleware } from "../src/policy/evaluate.js";
import { compilePolicy } from "../src/policy/registry.js";
import type { HorsResult, Middleware } from "../src/policy/types.js";
import { makeContext } from "./helpers/context.js";

describe("runMiddleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the handler once and returns its result when there is no middleware", async () => {
    const { ctx } = makeContext();
    const handler = vi.fn(async () => ({ ok: true }));
    await expect(runMiddleware(compilePolicy({}), ctx, handler)).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("composes middleware outermost-first around the handler", async () => {
    const { ctx } = makeContext();
    const trace: string[] = [];
    const a: Middleware = async (_c, next) => {
      trace.push("a:before");
      const result = await next();
      trace.push("a:after");
      return result;
    };
    const b: Middleware = async (_c, next) => {
      trace.push("b:before");
      const result = await next();
      trace.push("b:after");
      return result;
    };
    await runMiddleware(compilePolicy({ use: [a, b] }), ctx, async () => {
      trace.push("handler");
      return "ok";
    });
    expect(trace).toEqual(["a:before", "b:before", "handler", "b:after", "a:after"]);
  });

  it("lets outer middleware replace the inner result", async () => {
    const { ctx } = makeContext();
    const wrap: Middleware = async (_c, next) => {
      const inner = (await next()) as { ok: number };
      return { ok: inner.ok, wrapped: true };
    };
    await expect(
      runMiddleware(compilePolicy({ use: wrap }), ctx, async () => ({ ok: 1 })),
    ).resolves.toEqual({ ok: 1, wrapped: true });
  });

  it("short-circuits when middleware denies without calling next", async () => {
    const { ctx } = makeContext();
    const handler = vi.fn(async () => "ran");
    const deny: Middleware = async (c) => c.deny("nope", { code: "NOPE" });
    await expect(runMiddleware(compilePolicy({ use: deny }), ctx, handler)).rejects.toSatisfy(
      (error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("NOPE");
        expect((error as HorsError).message).toBe("nope");
        return true;
      },
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a second next() with HORS_POLICY_ERROR and still runs the handler once", async () => {
    const { ctx } = makeContext();
    const handler = vi.fn(async () => "ok");
    const twice: Middleware = async (_c, next) => {
      await next();
      await next();
      return "done";
    };
    await expect(runMiddleware(compilePolicy({ use: twice }), ctx, handler)).rejects.toSatisfy(
      (error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
        expect((error as HorsError).message).toBe("policy evaluation failed");
        return true;
      },
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("logs when middleware calls next() twice", async () => {
    const { ctx, logs } = makeContext();
    const twice: Middleware = async (_c, next) => {
      await next();
      await next();
      return "done";
    };
    await expect(
      runMiddleware(compilePolicy({ use: twice }), ctx, async () => "ok"),
    ).rejects.toSatisfy((error) => {
      expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      return true;
    });
    expect(logs.some((event) => event.message === "middleware called next() twice")).toBe(true);
  });

  it("does not turn a dropped next() into an unhandledRejection", async () => {
    const { ctx } = makeContext();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const drop: Middleware = async (_c, next) => {
        void next();
        return "early";
      };
      await expect(
        runMiddleware(compilePolicy({ use: drop }), ctx, async () => {
          throw new Error("handler failed");
        }),
      ).resolves.toBe("early");
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("wraps a thrown Error from middleware and rethrows a HorsError as-is", async () => {
    const { ctx, logs } = makeContext();
    const boom = new Error("boom");
    await expect(
      runMiddleware(
        compilePolicy({
          use: async () => {
            throw boom;
          },
        }),
        ctx,
        async () => "ok",
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      expect((error as HorsError).message).toBe("policy evaluation failed");
      expect((error as HorsError).cause).toBe(boom);
      return true;
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(expect.objectContaining({ level: "error", data: { message: "boom" } }));

    const denied = new HorsError("OVER_BUDGET", "over");
    await expect(
      runMiddleware(
        compilePolicy({
          use: async () => {
            throw denied;
          },
        }),
        ctx,
        async () => "ok",
      ),
    ).rejects.toBe(denied);
  });

  it("lets a handler Error escape unchanged with no log (M1 a)", async () => {
    const { ctx, logs } = makeContext();
    const down = new Error("db down");
    await expect(
      runMiddleware(compilePolicy({}), ctx, async () => {
        throw down;
      }),
    ).rejects.toBe(down);
    expect(logs).toEqual([]);
  });

  it("lets a handler Error escape through pass-through middleware (M1 b)", async () => {
    const { ctx, logs } = makeContext();
    const down = new Error("db down");
    const pass: Middleware = async (_c, next) => next();
    await expect(
      runMiddleware(compilePolicy({ use: pass }), ctx, async () => {
        throw down;
      }),
    ).rejects.toBe(down);
    expect(logs).toEqual([]);
  });

  it("wraps middleware that replaces a handler error (M1 c)", async () => {
    const { ctx, logs } = makeContext();
    const swap: Middleware = async (_c, next) => {
      try {
        return await next();
      } catch {
        throw new Error("mw");
      }
    };
    await expect(
      runMiddleware(compilePolicy({ use: swap }), ctx, async () => {
        throw new Error("db down");
      }),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      return true;
    });
    expect(logs).toEqual([expect.objectContaining({ level: "error", data: { message: "mw" } })]);
  });

  it("propagates a custom-code HorsError thrown by the handler (M1 d)", async () => {
    const { ctx } = makeContext();
    const denied = new HorsError("OVER_BUDGET", "over", { challenge: 1 });
    await expect(
      runMiddleware(compilePolicy({}), ctx, async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
  });

  it("lets a handler CONFIG_INVALID HorsError escape by identity (M1 e)", async () => {
    const { ctx } = makeContext();
    const invalid = new HorsError("CONFIG_INVALID", "x");
    await expect(
      runMiddleware(compilePolicy({}), ctx, async () => {
        throw invalid;
      }),
    ).rejects.toBe(invalid);
  });

  it("rejects a stashed next after the chain settled", async () => {
    const { ctx } = makeContext();
    const handler = vi.fn(async () => "ok");
    let stashed: (() => Promise<HorsResult>) | undefined;
    const stash: Middleware = async (c, next) => {
      stashed = next;
      return c.deny("nope");
    };
    await expect(runMiddleware(compilePolicy({ use: stash }), ctx, handler)).rejects.toSatisfy(
      (error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("HORS_RULE_DENIED");
        return true;
      },
    );
    await expect(stashed?.()).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      return true;
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("propagates only HORS and custom HorsError codes", async () => {
    const { ctx } = makeContext();
    for (const code of ["lower", "CONFIG_INVALID"] as const) {
      await expect(
        runMiddleware(
          compilePolicy({
            use: async () => {
              throw new HorsError(code, "x");
            },
          }),
          ctx,
          async () => "ok",
        ),
      ).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
        return true;
      });
    }
    const custom = new HorsError("OVER_BUDGET", "x");
    await expect(
      runMiddleware(
        compilePolicy({
          use: async () => {
            throw custom;
          },
        }),
        ctx,
        async () => "ok",
      ),
    ).rejects.toBe(custom);
    const unsigned = new HorsError("HORS_UNSIGNED", "x");
    await expect(
      runMiddleware(
        compilePolicy({
          use: async () => {
            throw unsigned;
          },
        }),
        ctx,
        async () => "ok",
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_POLICY_ERROR");
      return true;
    });
    const branded = denial("HORS_RULE_DENIED", "no");
    await expect(
      runMiddleware(
        compilePolicy({
          use: async () => {
            throw branded;
          },
        }),
        ctx,
        async () => "ok",
      ),
    ).rejects.toBe(branded);
  });

  it("shares ctx.state from middleware to the handler and creates no timers", async () => {
    const { ctx } = makeContext();
    const use: Middleware = async (c, next) => {
      c.state.fromUse = true;
      return next();
    };
    const result = await runMiddleware(compilePolicy({ use }), ctx, async () => {
      expect(ctx.state.fromUse).toBe(true);
      return "ok" as HorsResult;
    });
    expect(result).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});
