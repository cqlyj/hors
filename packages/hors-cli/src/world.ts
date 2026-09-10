import type { Address, HumanId } from "hors-sdk";
import { type AgentBook, createAgentBook } from "hors-sdk/world";
import { createPublicClient, http } from "viem";
import { worldchain } from "viem/chains";
import type { Io } from "./io.js";
import { thrownMessage } from "./util.js";

function defaultWorldRpc(): string {
  return worldchain.rpcUrls.default.http[0] ?? "https://worldchain-mainnet.g.alchemy.com/public";
}

export function agentBookFor(io: Pick<Io, "agentBook">, rpcUrl: string | undefined): AgentBook {
  return io.agentBook ?? createAgentBook({ rpcUrl });
}

export async function lookupLive(
  io: Pick<Io, "agentBook">,
  address: Address,
  rpcUrl: string | undefined,
): Promise<{ live: HumanId | null; error?: string }> {
  try {
    return { live: await agentBookFor(io, rpcUrl).lookupHuman(address) };
  } catch (error) {
    return { live: null, error: thrownMessage(error) };
  }
}

export async function worldChainBlock(
  rpcUrl?: string,
): Promise<{ number: bigint; timestamp: bigint }> {
  const client = createPublicClient({
    chain: worldchain,
    transport: http(rpcUrl ?? defaultWorldRpc()),
  });
  const block = await client.getBlock({ blockTag: "latest" });
  return { number: block.number, timestamp: block.timestamp };
}
