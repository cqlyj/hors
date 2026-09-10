import { http } from "viem";
import { worldchain } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HorsError } from "../src/errors.js";
import { type Address, normalizeHumanId } from "../src/identity.js";
import { MemoryStore } from "../src/store.js";
import {
  AGENTBOOK_ADDRESS,
  createAgentBook,
  RPC_TRANSPORT_OPTIONS,
} from "../src/world/agentbook.js";
import { fakeWorldChain } from "./helpers/worldchain.js";

const ADDR = "0xAbC0000000000000000000000000000000000001" as Address;
const ADDR_LOWER = ADDR.toLowerCase() as Address;
const HUMAN = normalizeHumanId(0xabcn);
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

describe("createAgentBook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("constructs without touching the network and accepts a client override", () => {
    expect(() => createAgentBook()).not.toThrow();
    const { client, calls } = fakeWorldChain();
    createAgentBook({ client });
    expect(calls).toEqual([]);
  });

  it("looks up a registered human once and caches for 60s", async () => {
    const { client, calls } = fakeWorldChain({ humans: { [ADDR]: 0xabcn } });
    const book = createAgentBook({ client });
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(calls).toEqual([expect.objectContaining({ fn: "lookupHuman", address: ADDR_LOWER })]);
    expect(calls[0]?.data.toLowerCase().startsWith("0x451a02f4")).toBe(true);

    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(calls).toHaveLength(1);

    vi.setSystemTime(T0 + 60_000);
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(calls).toHaveLength(2);
  });

  it("returns null for an unregistered address and caches the null for 10s exactly", async () => {
    const { client, calls } = fakeWorldChain();
    const book = createAgentBook({ client });
    expect(await book.lookupHuman(ADDR)).toBeNull();
    expect(calls).toHaveLength(1);

    vi.setSystemTime(T0 + 9_999);
    expect(await book.lookupHuman(ADDR)).toBeNull();
    expect(calls).toHaveLength(1);

    vi.setSystemTime(T0 + 10_000);
    expect(await book.lookupHuman(ADDR)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("keys the cache by lowercase address", async () => {
    const { client, calls } = fakeWorldChain({ humans: { [ADDR]: 0xabcn } });
    const book = createAgentBook({ client });
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(await book.lookupHuman(ADDR_LOWER)).toBe(HUMAN);
    expect(calls).toHaveLength(1);
  });

  it("serves a stale positive entry only while the RPC fails", async () => {
    const { client, calls, fail } = fakeWorldChain({ humans: { [ADDR]: 0xabcn } });
    const book = createAgentBook({ client });
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);

    vi.setSystemTime(T0 + 61_000);
    fail.current = true;
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(calls).toHaveLength(2);

    vi.setSystemTime(T0 + 600_000 + 61_000);
    await expect(book.lookupHuman(ADDR)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_UNAVAILABLE");
      expect((error as HorsError).message).toBe("AgentBook lookup failed");
      expect((error as HorsError).message).not.toContain("rpc down");
      expect((error as HorsError).cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it("never serves a stale null and fails closed for an unknown address", async () => {
    const { client, fail } = fakeWorldChain();
    const book = createAgentBook({ client });
    expect(await book.lookupHuman(ADDR)).toBeNull();

    vi.setSystemTime(T0 + 11_000);
    fail.current = true;
    await expect(book.lookupHuman(ADDR)).rejects.toEqual(
      expect.objectContaining({ code: "HORS_UNAVAILABLE", message: "AgentBook lookup failed" }),
    );

    const other = "0x0000000000000000000000000000000000000002" as Address;
    await expect(book.lookupHuman(other)).rejects.toEqual(
      expect.objectContaining({ code: "HORS_UNAVAILABLE" }),
    );
  });

  it("reads getNextNonce uncached and wraps RPC failures", async () => {
    const { client, calls, fail } = fakeWorldChain({ nonces: { [ADDR]: 7n } });
    const book = createAgentBook({ client });
    expect(await book.getNextNonce(ADDR)).toBe(7n);
    expect(await book.getNextNonce(ADDR)).toBe(7n);
    expect(calls.filter((call) => call.fn === "getNextNonce")).toHaveLength(2);
    expect(calls[0]?.data.toLowerCase().startsWith("0x90193b7c")).toBe(true);

    fail.current = true;
    await expect(book.getNextNonce(ADDR)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_UNAVAILABLE");
      expect((error as HorsError).message).toBe("AgentBook nonce read failed");
      expect((error as HorsError).message).not.toContain("rpc down");
      expect((error as HorsError).cause).toBeInstanceOf(Error);
      return true;
    });
  });

  it("honours per-field cache overrides and an injected store", async () => {
    const { client, calls } = fakeWorldChain({ humans: { [ADDR]: 0xabcn } });
    const store = new MemoryStore();
    const book = createAgentBook({ client, store, cache: { humanTtlMs: 5 } });
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    const cached = await store.get(`agentbook:${ADDR_LOWER}`);
    expect(JSON.parse(JSON.stringify(cached))).toEqual(cached);

    vi.setSystemTime(T0 + 5);
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(calls).toHaveLength(2);
  });

  it("talks to the canonical AgentBook address", () => {
    expect(AGENTBOOK_ADDRESS).toBe("0xA23aB2712eA7BBa896930544C7d6636a96b944dA");
  });

  it("builds transports with a 5s timeout and no retries", () => {
    const transport = http("http://127.0.0.1:9", RPC_TRANSPORT_OPTIONS)({ chain: worldchain });
    expect(transport.config.timeout).toBe(5000);
    expect(transport.config.retryCount).toBe(0);
    expect(() => createAgentBook()).not.toThrow();
  });

  it("treats a corrupt cache entry as a miss and overwrites it", async () => {
    const { client, calls } = fakeWorldChain({ humans: { [ADDR]: 0xabcn } });
    const store = new MemoryStore();
    await store.set(`agentbook:${ADDR_LOWER}`, {
      humanId: "0xgg",
      freshUntil: Number.POSITIVE_INFINITY,
    });
    const book = createAgentBook({ client, store });
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(calls).toHaveLength(1);
    expect(await store.get(`agentbook:${ADDR_LOWER}`)).toEqual({
      humanId: HUMAN,
      freshUntil: T0 + 60_000,
    });

    await store.set(`agentbook:${ADDR_LOWER}`, {
      humanId: null,
      freshUntil: Number.POSITIVE_INFINITY,
    });
    expect(await book.lookupHuman(ADDR)).toBe(HUMAN);
    expect(calls).toHaveLength(2);
  });

  it("fails closed when the cache get rejects and does not call the RPC", async () => {
    const { client, calls } = fakeWorldChain({ humans: { [ADDR]: 0xabcn } });
    const inner = new Error("redis down");
    const book = createAgentBook({
      client,
      store: {
        get: async () => {
          throw inner;
        },
        set: async () => undefined,
        incr: async () => 1,
        consumeOnce: async () => true,
        delete: async () => undefined,
      },
    });
    await expect(book.lookupHuman(ADDR)).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_UNAVAILABLE");
      expect((error as HorsError).message).toBe("AgentBook cache unavailable");
      expect((error as HorsError).cause).toBe(inner);
      return true;
    });
    expect(calls).toEqual([]);
  });
});
