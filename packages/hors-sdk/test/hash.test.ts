import { describe, expect, it } from "vitest";
import { hashArgs, hashBody } from "../src/hash.js";

const MCP_VECTOR = "f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab";
const EMPTY_OBJECT = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const ZERO_BYTES = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HEX64 = /^[0-9a-f]{64}$/;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("hashArgs and hashBody", () => {
  it("hashes canonical JSON of MCP arguments regardless of key order", async () => {
    expect(await hashArgs({ amount: 850, currency: "EUR" })).toBe(MCP_VECTOR);
    expect(await hashArgs({ currency: "EUR", amount: 850 })).toBe(MCP_VECTOR);
    expect(await hashArgs({ amount: 851, currency: "EUR" })).not.toBe(MCP_VECTOR);
  });

  it("treats absent MCP arguments as {}", async () => {
    expect(await hashArgs(undefined)).toBe(EMPTY_OBJECT);
    expect(await hashArgs({})).toBe(EMPTY_OBJECT);
  });

  it("hashes HTTP body bytes without parsing, so key order matters", async () => {
    expect(await hashBody(new Uint8Array(0))).toBe(ZERO_BYTES);
    expect(await hashBody(utf8('{"amount":850,"currency":"EUR"}'))).toBe(MCP_VECTOR);
    expect(await hashBody(utf8('{"currency":"EUR","amount":850}'))).not.toBe(MCP_VECTOR);
  });

  it("returns 64 lowercase hex characters with no prefix", async () => {
    const args = await hashArgs({ amount: 850, currency: "EUR" });
    const body = await hashBody(utf8("{}"));
    expect(args).toMatch(HEX64);
    expect(body).toMatch(HEX64);
    expect(args.startsWith("sha256:")).toBe(false);
    expect(body.startsWith("0x")).toBe(false);
  });
});
