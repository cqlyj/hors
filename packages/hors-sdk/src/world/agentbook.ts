import { createPublicClient, http, type PublicClient } from "viem";
import { worldchain } from "viem/chains";
import { HorsError } from "../errors.js";
import { type Address, type HumanId, isHumanId, normalizeHumanId } from "../identity.js";
import { MemoryStore, type Store } from "../store.js";

export const AGENTBOOK_ADDRESS: Address = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";

export const AGENTBOOK_ABI = [
  {
    type: "function",
    name: "lookupHuman",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getNextNonce",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// WHY: one attempt, so the worst case per RPC read is exactly the timeout;
// a 429 is treated like any failure, and a caller can retry with a fresh envelope.
export const RPC_TRANSPORT_OPTIONS = { timeout: 5_000, retryCount: 0 } as const;

export interface AgentBook {
  lookupHuman(address: Address): Promise<HumanId | null>;
  getNextNonce(address: Address): Promise<bigint>;
}

export interface AgentBookCache {
  humanTtlMs?: number;
  nullTtlMs?: number;
  staleTtlMs?: number;
}

export interface AgentBookOptions {
  rpcUrl?: string;
  client?: PublicClient;
  store?: Store;
  cache?: AgentBookCache;
}

interface CacheEntry {
  humanId: HumanId | null;
  freshUntil: number;
}

const DEFAULT_HUMAN_TTL_MS = 60_000;
const DEFAULT_NULL_TTL_MS = 10_000;
const DEFAULT_STALE_TTL_MS = 600_000;

function cacheKey(address: Address): string {
  return `agentbook:${address.toLowerCase()}`;
}

function asCacheEntry(value: unknown): CacheEntry | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const entry = value as { humanId?: unknown; freshUntil?: unknown };
  const humanId = entry.humanId;
  if (!(humanId === null || isHumanId(humanId))) {
    return undefined;
  }
  if (typeof entry.freshUntil !== "number" || !Number.isFinite(entry.freshUntil)) {
    return undefined;
  }
  return { humanId, freshUntil: entry.freshUntil };
}

function cacheUnavailable(error: unknown): never {
  if (error instanceof HorsError) {
    throw error;
  }
  throw new HorsError("HORS_UNAVAILABLE", "AgentBook cache unavailable", undefined, {
    cause: error,
  });
}

async function cacheGet(store: Store, key: string): Promise<unknown> {
  try {
    return await store.get(key);
  } catch (error) {
    cacheUnavailable(error);
  }
}

async function cacheSet(store: Store, key: string, value: unknown, ttlMs: number): Promise<void> {
  try {
    await store.set(key, value, ttlMs);
  } catch (error) {
    cacheUnavailable(error);
  }
}

export function createAgentBook(options?: AgentBookOptions): AgentBook {
  const client =
    options?.client ??
    createPublicClient({
      chain: worldchain,
      transport: http(options?.rpcUrl, RPC_TRANSPORT_OPTIONS),
    });
  const store = options?.store ?? new MemoryStore();
  const humanTtlMs = options?.cache?.humanTtlMs ?? DEFAULT_HUMAN_TTL_MS;
  const nullTtlMs = options?.cache?.nullTtlMs ?? DEFAULT_NULL_TTL_MS;
  const staleTtlMs = options?.cache?.staleTtlMs ?? DEFAULT_STALE_TTL_MS;

  return {
    async lookupHuman(address: Address): Promise<HumanId | null> {
      const normalised = address.toLowerCase() as Address;
      const key = cacheKey(normalised);
      const cached = asCacheEntry(await cacheGet(store, key));
      const now = Date.now();
      if (cached !== undefined && cached.freshUntil > now) {
        return cached.humanId;
      }

      let humanId: HumanId | null;
      try {
        const result = await client.readContract({
          address: AGENTBOOK_ADDRESS,
          abi: AGENTBOOK_ABI,
          functionName: "lookupHuman",
          args: [normalised],
        });
        humanId = result === 0n ? null : normalizeHumanId(result);
      } catch (error) {
        if (cached !== undefined && cached.humanId !== null) {
          return cached.humanId;
        }
        throw new HorsError("HORS_UNAVAILABLE", "AgentBook lookup failed", undefined, {
          cause: error,
        });
      }

      // WHY: an entry lives in the store for staleTtlMs (positives) or
      // nullTtlMs (negatives) but is fresh only until freshUntil; between
      // the two a positive is served only when the RPC fails.
      const freshUntil = now + (humanId === null ? nullTtlMs : humanTtlMs);
      const ttlMs = humanId === null ? nullTtlMs : staleTtlMs;
      await cacheSet(store, key, { humanId, freshUntil }, ttlMs);
      return humanId;
    },

    async getNextNonce(address: Address): Promise<bigint> {
      try {
        return await client.readContract({
          address: AGENTBOOK_ADDRESS,
          abi: AGENTBOOK_ABI,
          functionName: "getNextNonce",
          args: [address.toLowerCase() as Address],
        });
      } catch (error) {
        throw new HorsError("HORS_UNAVAILABLE", "AgentBook nonce read failed", undefined, {
          cause: error,
        });
      }
    },
  };
}
