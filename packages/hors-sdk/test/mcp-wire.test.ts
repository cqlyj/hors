import { describe, expect, it } from "vitest";
import { stampResult, toolsCallOf } from "../src/mcp/wire.js";

describe("MCP wire helpers", () => {
  it("returns non-object and array stampResult values unchanged (W5)", () => {
    const result = { v: 1 as const, status: "ok" as const, policy: null, local: false };
    expect(stampResult("text", result)).toBe("text");
    expect(stampResult(1, result)).toBe(1);
    expect(stampResult(null, result)).toBeNull();
    const array = [{ type: "text", text: "x" }];
    expect(stampResult(array, result)).toBe(array);
  });

  it("does not parse a tools/call with a float id or array _meta", () => {
    expect(
      toolsCallOf({
        jsonrpc: "2.0",
        id: 1.5,
        method: "tools/call",
        params: { name: "same" },
      }),
    ).toBeUndefined();
    expect(
      toolsCallOf({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "same", _meta: [] as never },
      }),
    ).toBeUndefined();
  });
});
