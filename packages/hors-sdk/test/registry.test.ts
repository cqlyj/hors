import { describe, expect, it } from "vitest";
import { HorsError } from "../src/errors.js";
import { publishPolicy } from "../src/policy/compile.js";
import { compilePolicy, definePolicy, lookupPolicy, PRESET_NAMES } from "../src/policy/registry.js";

function expectConfigInvalid(run: () => unknown): HorsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("CONFIG_INVALID");
    return error as HorsError;
  }
  expect.unreachable();
}

describe("policy registry", () => {
  it("resolves the three presets with name and a non-custom published form", () => {
    for (const name of PRESET_NAMES) {
      const found = compilePolicy(name);
      expect(found).toMatchObject({ name, origin: [name], custom: false });
      expect(publishPolicy(found)).toEqual({ v: 1, name, origin: [name], custom: false });
    }
  });

  it("accepts valid names and rejects invalid, preset, and duplicate names", () => {
    definePolicy("a", { origin: "public" });
    definePolicy("aqua-lp", { origin: "any-human" });
    definePolicy(`a${"b".repeat(63)}`, { origin: "same-human" });
    expect(lookupPolicy("a")?.name).toBe("a");
    expect(lookupPolicy("aqua-lp")?.name).toBe("aqua-lp");
    expect(lookupPolicy(`a${"b".repeat(63)}`)?.name).toBe(`a${"b".repeat(63)}`);

    for (const name of ["Aqua", "1x", "-a", "a_b", `a${"b".repeat(64)}`, ...PRESET_NAMES]) {
      expectConfigInvalid(() => definePolicy(name, { origin: "public" }));
    }
    expectConfigInvalid(() => definePolicy("a", { origin: "public" }));
    expectConfigInvalid(() => definePolicy(null as never, { origin: "public" }));
  });

  it("compiles a named policy at definition so an empty origin fails there", () => {
    expectConfigInvalid(() => definePolicy("bad-origin", { origin: [] }));
    expect(lookupPolicy("bad-origin")).toBeUndefined();
  });

  it("rejects a string in definePolicy rather than aliasing a preset", () => {
    expectConfigInvalid(() => definePolicy("alias", "same-human" as never));
    expect(lookupPolicy("alias")).toBeUndefined();
  });

  it("rejects sparse origin and rule arrays and an oversized describe", () => {
    // biome-ignore lint/suspicious/noSparseArray: construction must reject holes, not only undefined
    expectConfigInvalid(() => definePolicy("sparse-origin", { origin: [, "public"] as never }));
    expectConfigInvalid(() => definePolicy("sparse-holes", { origin: new Array(3) as never }));
    // biome-ignore lint/suspicious/noSparseArray: construction must reject holes, not only undefined
    expectConfigInvalid(() => definePolicy("sparse-rule", { rule: [, () => true] as never }));
    expectConfigInvalid(() => definePolicy("long-describe", { describe: "a".repeat(513) }));
    expectConfigInvalid(() => definePolicy("nl-describe", { describe: "a\nb" }));
    definePolicy("ok-describe", { describe: "a".repeat(512) });
    expect(compilePolicy("ok-describe").describe).toHaveLength(512);
  });

  it("returns undefined for an unknown name and compilePolicy names it", () => {
    expect(lookupPolicy("nope")).toBeUndefined();
    const error = expectConfigInvalid(() => compilePolicy("nope"));
    expect(error.message).toContain("unknown policy");
    expect(error.message).toContain("nope");
  });

  it("truncates a long unknown policy name in the CONFIG_INVALID message", () => {
    const name = "n".repeat(300);
    const error = expectConfigInvalid(() => compilePolicy(name));
    expect(error.message).toContain("unknown policy");
    expect(error.message).toContain("n".repeat(64));
    expect(error.message).not.toContain("n".repeat(65));
    expect(error.message.length).toBeLessThan(100);
  });
});
