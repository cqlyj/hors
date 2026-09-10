import { describe, expect, it } from "vitest";
import { HorsError } from "../src/errors.js";
import { normalizeHumanId } from "../src/identity.js";
import { compilePolicy, definePolicy } from "../src/policy/registry.js";
import type { Middleware, OriginFn, Rule } from "../src/policy/types.js";

const HUMAN_ABC = normalizeHumanId("0xABC");
const allow: Rule = () => true;
const originFn: OriginFn = () => true;
const mw: Middleware = async (_ctx, next) => next();
const ORIGIN_MEMBER =
  "origin member must be same-human, any-human, public, a humanId or a function";

function expectConfigInvalid(run: () => unknown, named?: string): HorsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("CONFIG_INVALID");
    if (named !== undefined) {
      expect((error as HorsError).message).toContain(named);
    }
    return error as HorsError;
  }
  expect.unreachable();
}

describe("compilePolicy", () => {
  it("normalises scalar origin, rule and use into arrays and defaults the rest", () => {
    expect(compilePolicy({ origin: "public" }).origin).toEqual(["public"]);
    expect(compilePolicy({ rule: allow }).rule).toEqual([allow]);
    expect(compilePolicy({ use: mw }).use).toEqual([mw]);
    expect(compilePolicy({}).origin).toEqual(["same-human"]);
    expect(compilePolicy({}).rule).toEqual([]);
    expect(compilePolicy({}).use).toEqual([]);
  });

  it("sets custom for a function origin, a rule, or middleware, and not for literals only", () => {
    expect(compilePolicy({ origin: "public" }).custom).toBe(false);
    expect(compilePolicy({ origin: originFn }).custom).toBe(true);
    expect(compilePolicy({ rule: allow }).custom).toBe(true);
    expect(compilePolicy({ use: mw }).custom).toBe(true);
  });

  it("rejects values that are not plain policy objects", () => {
    expectConfigInvalid(() => compilePolicy(null));
    expectConfigInvalid(() => compilePolicy([]));
    expectConfigInvalid(() => compilePolicy(() => {}));
    expectConfigInvalid(() => compilePolicy(new (class {})()));
    expectConfigInvalid(() => compilePolicy(42));
  });

  it("rejects unknown keys so a typo cannot silently drop rules", () => {
    expectConfigInvalid(() => compilePolicy({ rules: [] }), "rules");
    expectConfigInvalid(() => compilePolicy({ origins: ["public"] }), "origins");
    expectConfigInvalid(() => compilePolicy({ origin: "public", extra: 1 }), "extra");
  });

  it("rejects an empty origin and each invalid origin member", () => {
    expectConfigInvalid(() => compilePolicy({ origin: [] }));
    for (const member of ["owner", 1, 1n, [1n], null, {}, "0x0", "0xzz"]) {
      const error = expectConfigInvalid(() => compilePolicy({ origin: member as never }));
      expect(error.message).toBe(ORIGIN_MEMBER);
    }
  });

  it("rejects sparse origin and rule arrays so holes cannot compile", () => {
    // biome-ignore lint/suspicious/noSparseArray: construction must reject holes, not only undefined
    expectConfigInvalid(() => compilePolicy({ origin: [, "public"] as never }));
    expectConfigInvalid(() => compilePolicy({ origin: new Array(3) as never }));
    // biome-ignore lint/suspicious/noSparseArray: construction must reject holes, not only undefined
    expectConfigInvalid(() => compilePolicy({ rule: [, () => true] as never }));
  });

  it("rejects a describe that is too long or contains control characters", () => {
    expectConfigInvalid(() => compilePolicy({ describe: "a".repeat(513) }));
    expectConfigInvalid(() => compilePolicy({ describe: "a\nb" }));
    expect(compilePolicy({ describe: "a".repeat(512) }).describe).toHaveLength(512);
  });

  it("normalises a HumanId literal and keeps duplicate origin members", () => {
    expect(compilePolicy({ origin: "0xABC" }).origin).toEqual([HUMAN_ABC]);
    expect(compilePolicy({ origin: ["public", "public"] }).origin).toEqual(["public", "public"]);
  });

  it("rejects non-function rule and use values and a non-string describe", () => {
    expectConfigInvalid(() => compilePolicy({ rule: "x" }));
    expectConfigInvalid(() => compilePolicy({ rule: [() => true, 1] }));
    expectConfigInvalid(() => compilePolicy({ use: {} }));
    expectConfigInvalid(() => compilePolicy({ describe: 1 }));
  });

  it("omits the name key on an inline compiled policy", () => {
    const compiled = compilePolicy({ origin: "public" });
    expect(Object.hasOwn(compiled, "name")).toBe(false);
  });

  it("does not mutate the input object or arrays and returns fresh origin copies", () => {
    const origin: Array<"public" | "any-human"> = ["public", "any-human"];
    const input = { origin, rule: [allow] };
    const snapshot = { origin: [...origin], rule: [allow] };
    const compiled = compilePolicy(input);
    expect(input).toEqual(snapshot);
    expect(input.origin).toBe(origin);
    expect(compiled.origin).not.toBe(input.origin);
    expect(compiled.rule).not.toBe(input.rule);
  });

  it("compiles a defined name to the named policy", () => {
    definePolicy("compile-named", { origin: "any-human" });
    const compiled = compilePolicy("compile-named");
    expect(compiled.name).toBe("compile-named");
    expect(compiled.origin).toEqual(["any-human"]);
  });
});
