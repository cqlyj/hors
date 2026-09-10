import { HorsError } from "hors-sdk";
import { describe, expect, it } from "vitest";
import { asOutcome, errorText } from "../src/util.js";

describe("errorText (D1.4)", () => {
  it("appends only the cause's first line, capped at 200 characters", () => {
    const chunk = "x".repeat(420);
    const cause = new Error([chunk, chunk, chunk, chunk, chunk].join("\n"));
    expect(cause.message.length).toBeGreaterThan(2048);
    const error = new HorsError("RESOLVER_FAILED", "tokenURI read failed", undefined, { cause });
    const text = errorText(error);
    expect(text).toBe(`tokenURI read failed: ${"x".repeat(200)}…`);
    expect(text).not.toContain("second");
    const outcome = asOutcome(error);
    expect(outcome).toMatchObject({
      type: "err",
      code: "RESOLVER_FAILED",
      message: text,
    });
  });
});
