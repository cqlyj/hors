import { describe, expect, it } from "vitest";
import { type Address, isHumanId } from "../src/identity.js";
import { MockAgentBook } from "../src/world/mock.js";

const ADDR = "0xabc0000000000000000000000000000000000001" as Address;
const ADDR_MIXED = "0xAbC0000000000000000000000000000000000001" as Address;
const OTHER = "0x0000000000000000000000000000000000000001" as Address;

describe("MockAgentBook", () => {
  it("derives deterministic humanIds from the address, case-insensitively", () => {
    expect(MockAgentBook.humanIdOf(ADDR)).toBe(
      "0x53ea05eb75be56f1427717099feba9f5dffe2240599d5dbe24de92a314509533",
    );
    expect(MockAgentBook.humanIdOf(ADDR_MIXED)).toBe(MockAgentBook.humanIdOf(ADDR));
    expect(MockAgentBook.humanIdOf(OTHER)).toBe(
      "0x8318541d0574d168d27680dff9c65eabe15e2607d3ff814bc2804ba7cf8fa2e5",
    );
    expect(MockAgentBook.humanIdOf(ADDR)).not.toBe(MockAgentBook.humanIdOf(OTHER));
    expect(isHumanId(MockAgentBook.humanIdOf(ADDR))).toBe(true);
  });

  it("returns the derived id, never null, and always nonce 1n", async () => {
    const book = new MockAgentBook();
    expect(await book.lookupHuman(ADDR_MIXED)).toBe(MockAgentBook.humanIdOf(ADDR));
    expect(await book.getNextNonce(ADDR)).toBe(1n);
  });
});
