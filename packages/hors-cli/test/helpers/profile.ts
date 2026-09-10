import type { Address, HumanId } from "hors-sdk";
import { createProfile, type ProfileRecord, writeProfile } from "hors-sdk/node";
import { type AgentBook, MockAgentBook } from "hors-sdk/world";

export const HUMAN_B = `0x${"b".repeat(64)}` as const;

export function overrideBook(
  pairs: ReadonlyArray<readonly [string, HumanId]> = [],
): AgentBook & { nonce: bigint; set(address: string, humanId: HumanId): void } {
  const overrides = new Map<string, HumanId>();
  for (const [address, humanId] of pairs) {
    overrides.set(address.toLowerCase(), humanId);
  }
  const book = {
    nonce: 1n,
    set(address: string, humanId: HumanId) {
      overrides.set(address.toLowerCase(), humanId);
    },
    async lookupHuman(address: Address) {
      return overrides.get(address.toLowerCase()) ?? MockAgentBook.humanIdOf(address);
    },
    async getNextNonce() {
      return book.nonce;
    },
  };
  return book;
}

export async function pinProfile(
  home: string,
  name = "default",
): Promise<ProfileRecord & { humanId: `0x${string}` }> {
  const record = await createProfile(home, name);
  const humanId = MockAgentBook.humanIdOf(record.address);
  const pinned = { ...record, humanId, registeredAt: "2026-01-01T00:00:00.000Z" };
  await writeProfile(home, name, pinned);
  return { ...pinned, humanId };
}
