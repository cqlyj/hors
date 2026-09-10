import { describe, expect, it } from "vitest";
import {
  isAddress,
  isChainId,
  isHumanId,
  normalizeAddress,
  normalizeHumanId,
  parseHumanId,
} from "../src/identity.js";

const PADDED_ABC = `0x${"0".repeat(61)}abc`;

function expectConfigInvalid(run: () => unknown, banned: string): void {
  try {
    run();
    expect.unreachable();
  } catch (error) {
    expect(error).toEqual(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect((error as Error).message).not.toContain(banned);
  }
}

describe("humanId and address", () => {
  it("parses accepted shapes and returns undefined for everything else", () => {
    expect(parseHumanId("0xABC")).toBe(PADDED_ABC);
    expect(parseHumanId("0x0")).toBeUndefined();
    expect(parseHumanId("")).toBeUndefined();
    expect(parseHumanId("xyz")).toBeUndefined();
    expect(parseHumanId(1)).toBeUndefined();
    expect(parseHumanId(null)).toBeUndefined();
    expect(parseHumanId(1n)).toBe(`0x${"0".repeat(63)}1`);
    expect(parseHumanId(0n)).toBeUndefined();
  });

  it("normalises unpadded, mixed-case and bigint humanIds to 64 lowercase hex", () => {
    expect(normalizeHumanId("0xabc")).toBe(PADDED_ABC);
    expect(normalizeHumanId("0xABC")).toBe(PADDED_ABC);
    expect(normalizeHumanId(0xabcn)).toBe(PADDED_ABC);
    expect(normalizeHumanId(`0x${"A".repeat(64)}`)).toBe(`0x${"a".repeat(64)}`);
  });

  it("rejects empty, unprefixed, overlong, zero and out-of-range humanIds", () => {
    expectConfigInvalid(() => normalizeHumanId("abc"), "abc");
    expectConfigInvalid(() => normalizeHumanId(`0x${"a".repeat(65)}`), "aaa");
    expectConfigInvalid(() => normalizeHumanId("0x0"), "0x0");
    expect(() => normalizeHumanId("0x")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => normalizeHumanId(0n)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expectConfigInvalid(() => normalizeHumanId(2n ** 256n), "115792");
    expect(() => normalizeHumanId({ toString: () => "0xabc" } as never)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("recognises only the normalised non-zero form as a humanId", () => {
    expect(isHumanId(PADDED_ABC)).toBe(true);
    expect(isHumanId("0xabc")).toBe(false);
    expect(isHumanId(`0x${"A".repeat(64)}`)).toBe(false);
    expect(isHumanId(`0x${"0".repeat(64)}`)).toBe(false);
    expect(isHumanId(0xabcn)).toBe(false);
    expect(isHumanId(null)).toBe(false);
  });

  it("lowercases checksummed addresses and rejects wrong lengths", () => {
    expect(isAddress("0xAbC0000000000000000000000000000000000001")).toBe(true);
    expect(normalizeAddress("0xAbC0000000000000000000000000000000000001")).toBe(
      "0xabc0000000000000000000000000000000000001",
    );
    expect(isAddress(`0x${"a".repeat(39)}`)).toBe(false);
    expect(isAddress(`0x${"a".repeat(41)}`)).toBe(false);
    expect(isAddress("AbC0000000000000000000000000000000000001")).toBe(false);
    expect(isAddress("0xzz00000000000000000000000000000000000001")).toBe(false);
    expectConfigInvalid(() => normalizeAddress(`0x${"a".repeat(39)}`), "aaa");
    expectConfigInvalid(() => normalizeAddress("not-an-address"), "not-an-address");
  });

  it("accepts CAIP-2 eip155 ids that are positive safe integers without leading zeros", () => {
    expect(isChainId("eip155:1")).toBe(true);
    expect(isChainId("eip155:480")).toBe(true);
    expect(isChainId("eip155:9007199254740991")).toBe(true);
    expect(isChainId("eip155:0")).toBe(false);
    expect(isChainId("eip155:01")).toBe(false);
    expect(isChainId("eip155:")).toBe(false);
    expect(isChainId("eip155:9007199254740992")).toBe(false);
    expect(isChainId("solana:x")).toBe(false);
    expect(isChainId(1)).toBe(false);
    expect(isChainId(null)).toBe(false);
  });
});
