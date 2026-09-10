import { describe, expect, it } from "vitest";
import { HorsError } from "../src/errors.js";
import { denialFrom, MAX_REASON_LENGTH, okResult } from "../src/gate/result.js";
import { compilePolicy } from "../src/policy/registry.js";
import { memoryLogger } from "./helpers/logger.js";

const named = compilePolicy("same-human");
const inline = compilePolicy({ origin: "public" });

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

describe("okResult and denialFrom", () => {
  it("stamps an ok result with policy, local and optional mock (R1)", () => {
    expect(okResult(named, false, false)).toEqual({
      v: 1,
      status: "ok",
      policy: "same-human",
      local: false,
    });
    expect(Object.keys(okResult(named, false, false))).toEqual(["v", "status", "policy", "local"]);
    const mocked = okResult(inline, true, true);
    expect(mocked).toEqual({ v: 1, status: "ok", policy: null, local: true, mock: true });
    expect(Object.keys(mocked)).toEqual(["v", "status", "policy", "local", "mock"]);
  });

  it("converts a HORS denial and a custom challenge (R3)", () => {
    const { log } = memoryLogger();
    const unsigned = denialFrom(new HorsError("HORS_UNSIGNED", "envelope required"), {
      policy: named,
      local: false,
      mock: false,
      log,
    });
    expect(unsigned).toMatchObject({
      code: "HORS_UNSIGNED",
      status: 401,
      reason: "envelope required",
      challenge: null,
      text: "HORS_UNSIGNED: envelope required",
    });
    expect(Object.keys(unsigned.result)).toEqual([
      "v",
      "status",
      "code",
      "reason",
      "policy",
      "challenge",
      "local",
    ]);

    const custom = denialFrom(new HorsError("OVER_BUDGET", "over", { challenge: { pay: 1 } }), {
      policy: named,
      local: false,
      mock: false,
      log,
    });
    expect(custom.status).toBe(403);
    expect(custom.challenge).toEqual({ pay: 1 });

    const noChallenge = denialFrom(new HorsError("HORS_RULE_DENIED", "x", { other: 1 }), {
      policy: named,
      local: false,
      mock: false,
      log,
    });
    expect(noChallenge.challenge).toBeNull();
  });

  it("hides internal failures behind HORS_POLICY_ERROR (R3)", () => {
    const cases: Array<{ error: unknown; message: string }> = [
      { error: new HorsError("CONFIG_INVALID", "secret detail"), message: "secret detail" },
      { error: new Error("boom"), message: "boom" },
      { error: "str", message: "str" },
    ];
    for (const { error, message } of cases) {
      const { log, events } = memoryLogger();
      const denial = denialFrom(error, { policy: named, local: false, mock: false, log });
      expect(denial.code).toBe("HORS_POLICY_ERROR");
      expect(denial.status).toBe(500);
      expect(denial.reason).toBe("policy evaluation failed");
      expect(denial.reason).not.toContain(message);
      expect(events).toEqual([
        expect.objectContaining({
          level: "error",
          message: "gate failure",
          data: { message },
        }),
      ]);
    }
  });

  it("maps an empty HORS reason to denied (R2)", () => {
    const { log } = memoryLogger();
    const empty = denialFrom(new HorsError("HORS_RULE_DENIED", ""), {
      policy: named,
      local: false,
      mock: false,
      log,
    });
    expect(empty.reason).toBe("denied");
    expect(empty.text).toBe("HORS_RULE_DENIED: denied");
  });

  it("drops a non-JSON challenge and keeps a JSON one", () => {
    const { log, events } = memoryLogger();
    const dropped = denialFrom(new HorsError("OVER_BUDGET", "over", { challenge: 1n }), {
      policy: named,
      local: false,
      mock: false,
      log,
    });
    expect(dropped.challenge).toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({ level: "error", message: "challenge is not JSON; dropped" }),
    );

    const kept = denialFrom(new HorsError("OVER_BUDGET", "over", { challenge: { price: 1 } }), {
      policy: named,
      local: false,
      mock: false,
      log,
    });
    expect(kept.challenge).toEqual({ price: 1 });

    const stripped = denialFrom(
      new HorsError("OVER_BUDGET", "over", {
        challenge: {
          a: 1,
          f() {},
        },
      }),
      { policy: named, local: false, mock: false, log },
    );
    expect(stripped.challenge).toEqual({ a: 1 });
  });

  it("strips control characters from a caller-visible reason", () => {
    const { log } = memoryLogger();
    const denial = denialFrom(
      new HorsError("HORS_DOMAIN_MISMATCH", "expected work\texample.com/"),
      {
        policy: named,
        local: false,
        mock: false,
        log,
      },
    );
    expect(denial.reason).toBe("expected work example.com/");
    expect(hasControlChars(denial.reason)).toBe(false);
  });

  it("strips C1 control characters from a caller-visible reason", () => {
    const { log } = memoryLogger();
    const denial = denialFrom(
      new HorsError("HORS_DOMAIN_MISMATCH", "expected work\u0085example.com/"),
      {
        policy: named,
        local: false,
        mock: false,
        log,
      },
    );
    expect(denial.reason).toBe("expected work example.com/");
  });

  it("sanitises a Host with an embedded TAB in the domain-mismatch reason", () => {
    const { log } = memoryLogger();
    const denial = denialFrom(
      new HorsError("HORS_DOMAIN_MISMATCH", "expected work.example.com\t/mcp; envelope signed x"),
      { policy: named, local: false, mock: false, log },
    );
    expect(hasControlChars(denial.reason)).toBe(false);
  });

  it("caps a long reason and appends mock on denials (R2, R3)", () => {
    const { log } = memoryLogger();
    const long = denialFrom(new HorsError("HORS_RULE_DENIED", "x".repeat(2000)), {
      policy: named,
      local: true,
      mock: true,
      log,
    });
    expect(long.reason).toHaveLength(MAX_REASON_LENGTH);
    expect(long.result.mock).toBe(true);
    expect(Object.keys(long.result)).toEqual([
      "v",
      "status",
      "code",
      "reason",
      "policy",
      "challenge",
      "local",
      "mock",
    ]);
  });
});
