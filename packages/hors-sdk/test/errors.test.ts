import { describe, expect, it } from "vitest";
import {
  denial,
  echo,
  HORS_CODES,
  HorsError,
  httpStatus,
  isCustomCode,
  isDenial,
  isPolicyDenial,
  SDK_CODES,
  thrownMessage,
} from "../src/errors.js";

describe("HorsError and codes", () => {
  it("is an Error named HorsError that exposes code, message and data", () => {
    const error = new HorsError("HORS_BAD_ENVELOPE", "bad envelope: nonce", { field: "nonce" });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HorsError);
    expect(error.name).toBe("HorsError");
    expect(error.code).toBe("HORS_BAD_ENVELOPE");
    expect(error.message).toBe("bad envelope: nonce");
    expect(error.data).toEqual({ field: "nonce" });
  });

  it("keeps cause without rendering it into the message", () => {
    const inner = new Error("rpc down");
    const error = new HorsError("HORS_UNAVAILABLE", "x", undefined, { cause: inner });
    expect(error.cause).toBe(inner);
    expect(error.message).toBe("x");
  });

  it("maps the 17 HORS_* codes to their HTTP statuses and lists the four SDK codes", () => {
    expect(HORS_CODES).toEqual({
      HORS_UNSIGNED: 401,
      HORS_BAD_ENVELOPE: 400,
      HORS_DOMAIN_MISMATCH: 403,
      HORS_EXPIRED: 403,
      HORS_VERSION: 400,
      HORS_FUNCTION_MISMATCH: 403,
      HORS_ARGS_MISMATCH: 403,
      HORS_BAD_SIGNATURE: 403,
      HORS_REPLAY: 403,
      HORS_DENIED_WALLET: 403,
      HORS_NOT_HUMAN: 403,
      HORS_ORIGIN_MISMATCH: 403,
      HORS_RULE_DENIED: 403,
      HORS_POLICY_ERROR: 500,
      HORS_LOCAL_DISABLED: 403,
      HORS_OWNER_UNRESOLVED: 503,
      HORS_UNAVAILABLE: 503,
    });
    expect(SDK_CODES).toEqual([
      "PROFILE_NOT_FOUND",
      "CONFIG_INVALID",
      "RESOLVER_FAILED",
      "REGISTRATION_FAILED",
    ]);
  });

  it("accepts custom codes and rejects HORS_ prefixes and malformed names", () => {
    expect(isCustomCode("OVER_BUDGET")).toBe(true);
    expect(isCustomCode("PAYMENT_REQUIRED")).toBe(true);
    expect(isCustomCode("A12")).toBe(true);
    expect(isCustomCode("HORS_X")).toBe(false);
    expect(isCustomCode("over_budget")).toBe(false);
    expect(isCustomCode("AB")).toBe(false);
    expect(isCustomCode("1ABC")).toBe(false);
    expect(isCustomCode(`A${"B".repeat(64)}`)).toBe(false);
    expect(isCustomCode("")).toBe(false);
    expect(isCustomCode(["OVER_BUDGET"])).toBe(false);
    expect(isCustomCode(new String("OVER_BUDGET"))).toBe(false);
    expect(isCustomCode({ toString: () => "OVER_BUDGET" })).toBe(false);
    expect(isCustomCode(1)).toBe(false);
    expect(isCustomCode(null)).toBe(false);
    expect(isCustomCode("CONFIG_INVALID")).toBe(false);
    expect(isCustomCode("REGISTRATION_FAILED")).toBe(false);
    expect(isCustomCode("OVER_BUDGET")).toBe(true);
  });

  it("echoes deployer-supplied strings truncated to 64 characters", () => {
    expect(echo("n".repeat(300))).toHaveLength(64);
  });

  it("reads a thrown value and maps HTTP statuses", () => {
    expect(thrownMessage(new Error("boom"))).toBe("boom");
    expect(thrownMessage("str")).toBe("str");
    expect(httpStatus("HORS_UNSIGNED")).toBe(401);
    expect(httpStatus("OVER_BUDGET")).toBe(403);
  });

  it("brands denial() and treats custom codes as policy denials", () => {
    const branded = denial("OVER_BUDGET", "over", { price: 1 });
    expect(isDenial(branded)).toBe(true);
    expect(isPolicyDenial(branded)).toBe(true);
    expect(branded.data).toEqual({ challenge: { price: 1 } });
    expect(isDenial(new HorsError("HORS_UNSIGNED", "x"))).toBe(false);
    expect(isPolicyDenial(new HorsError("HORS_UNSIGNED", "x"))).toBe(false);
    expect(isPolicyDenial(new HorsError("OVER_BUDGET", "over"))).toBe(true);
    const caught = denial("HORS_RULE_DENIED", "no");
    expect(isPolicyDenial(caught)).toBe(true);
  });
});
