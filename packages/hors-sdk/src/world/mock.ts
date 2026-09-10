import { keccak256, stringToBytes } from "viem";
import { type Address, type HumanId, normalizeHumanId } from "../identity.js";
import type { AgentBook } from "./agentbook.js";

export class MockAgentBook implements AgentBook {
  static humanIdOf(address: Address): HumanId {
    return normalizeHumanId(keccak256(stringToBytes(`hors-mock${address.toLowerCase()}`)));
  }

  async lookupHuman(address: Address): Promise<HumanId | null> {
    return MockAgentBook.humanIdOf(address);
  }

  async getNextNonce(_address: Address): Promise<bigint> {
    return 1n;
  }
}
