import { describe, expect, it } from "vitest";
import {
  ARGS_URN_PATTERN,
  argsUrn,
  encodeFunctionId,
  functionIdFromUrn,
  functionUrn,
  HORS_VERSION_URN,
  httpFunctionId,
  normalizePath,
} from "../src/binding.js";

const ARGS_HASH = "f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab";
const ARGS_URN = `urn:hors:args:sha256:${ARGS_HASH}`;

function expectBadEnvelope(run: () => unknown, banned?: string): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toEqual(expect.objectContaining({ code: "HORS_BAD_ENVELOPE" }));
    if (banned !== undefined) {
      expect((error as Error).message).not.toContain(banned);
    }
  }
}

describe("HORS URNs and function identifiers", () => {
  it("percent-encodes function ids outside [A-Za-z0-9._-] with uppercase hex", () => {
    expect(encodeFunctionId("approveTravelExpense")).toBe("approveTravelExpense");
    expect(encodeFunctionId("POST /approve")).toBe("POST%20%2Fapprove");
    expect(encodeFunctionId("a~b!c")).toBe("a%7Eb%21c");
    expect(encodeFunctionId("é")).toBe("%C3%A9");
    expect(functionUrn("approveTravelExpense")).toBe("urn:hors:fn:approveTravelExpense");
    expect(HORS_VERSION_URN).toBe("urn:hors:v:1");
    expectBadEnvelope(() => functionUrn(""));
    expectBadEnvelope(() => functionUrn("a\ud800b"));
  });

  it("round-trips function URNs and rejects malformed remainders", () => {
    const ids = ["approveTravelExpense", "POST /approve", "a~b!c", "é"] as const;
    for (const id of ids) {
      expect(functionIdFromUrn(functionUrn(id))).toBe(id);
    }
    expectBadEnvelope(() => functionIdFromUrn("urn:hors:args:sha256:ab"), "urn:hors:args");
    expectBadEnvelope(() => functionIdFromUrn("urn:hors:fn:"));
    expectBadEnvelope(() => functionIdFromUrn("urn:hors:fn:%2f"), "%2f");
    expectBadEnvelope(() => functionIdFromUrn("urn:hors:fn:POST /approve"));
    expectBadEnvelope(() => functionIdFromUrn("urn:hors:fn:%E9"), "%E9");
    expectBadEnvelope(
      () => functionIdFromUrn("urn:hors:fn:%61pproveTravelExpense"),
      "%61pproveTravelExpense",
    );
  });

  it("builds args URNs from lowercase hex and matches the URN pattern", () => {
    expect(argsUrn(ARGS_HASH)).toBe(ARGS_URN);
    expect(ARGS_URN_PATTERN.test(ARGS_URN)).toBe(true);
    expectBadEnvelope(() => argsUrn(ARGS_HASH.toUpperCase()), "F179");
    expectBadEnvelope(() => argsUrn(ARGS_HASH.slice(0, 63)));
  });

  it("normalises HTTP paths and builds METHOD /path identifiers", () => {
    expect(normalizePath("/approve/")).toBe("/approve");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/a//")).toBe("/a/");
    expect(normalizePath("/approve")).toBe("/approve");
    expect(httpFunctionId("post", "/approve/")).toBe("POST /approve");
    expectBadEnvelope(() => httpFunctionId("GET", "/x?y=1"), "?");
    expectBadEnvelope(() => httpFunctionId("GET", "/x#frag"), "#");
  });
});
