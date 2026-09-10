import { describe, expect, it } from "vitest";
import { normalizeHumanId } from "../src/identity.js";
import { policyView, publishPolicy } from "../src/policy/compile.js";
import { compilePolicy, definePolicy } from "../src/policy/registry.js";
import type { OriginFn, Rule } from "../src/policy/types.js";

const HUMAN_ABC = normalizeHumanId("0xABC");
const fn: OriginFn = () => true;
const rule: Rule = () => true;

describe("publishPolicy and policyView", () => {
  it("publishes a preset with key order v, name, origin, custom", () => {
    const published = publishPolicy(compilePolicy("same-human"));
    expect(published).toEqual({ v: 1, name: "same-human", origin: ["same-human"], custom: false });
    expect(Object.keys(published)).toEqual(["v", "name", "origin", "custom"]);
  });

  it("publishes a named policy with function origins as custom and describe", () => {
    definePolicy("aqua-lp", {
      origin: ["any-human", fn],
      rule,
      describe: "Requires an open 1inch Aqua liquidity position",
    });
    const named = compilePolicy("aqua-lp");
    const published = publishPolicy(named);
    expect(published).toEqual({
      v: 1,
      name: "aqua-lp",
      origin: ["any-human", "custom"],
      custom: true,
      describe: "Requires an open 1inch Aqua liquidity position",
    });
    expect(Object.keys(published)).toEqual(["v", "name", "origin", "custom", "describe"]);
    expect(policyView(named)).toEqual({
      name: "aqua-lp",
      origin: ["any-human", "custom"],
    });
  });

  it("publishes a HumanId literal as human and keeps the literal in policyView", () => {
    const compiled = compilePolicy({ origin: ["0xABC"] });
    const published = publishPolicy(compiled);
    expect(published).toEqual({ v: 1, origin: ["human"], custom: false });
    expect(Object.hasOwn(published, "name")).toBe(false);
    expect(JSON.stringify(published)).not.toContain("0abc");
    expect(policyView(compiled)).toEqual({ origin: [HUMAN_ABC] });
    expect(JSON.parse(JSON.stringify(published))).toEqual(published);
  });
});
