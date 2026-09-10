import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store.js";

describe("MemoryStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets, gets and deletes values, including missing keys", async () => {
    const store = new MemoryStore();
    expect(await store.get("missing")).toBeUndefined();
    await store.set("k", { n: 1 });
    expect(await store.get("k")).toEqual({ n: 1 });
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("expires TTL entries at the deadline and keeps entries without a TTL", async () => {
    const store = new MemoryStore();
    await store.set("ttl", "v", 1000);
    await store.set("keep", "v");
    expect(await store.get("ttl")).toBe("v");
    vi.advanceTimersByTime(999);
    expect(await store.get("ttl")).toBe("v");
    vi.advanceTimersByTime(1);
    expect(await store.get("ttl")).toBeUndefined();
    vi.advanceTimersByTime(1_000_000);
    expect(await store.get("keep")).toBe("v");
  });

  it("sets TTL on the first increment only and rejects non-numeric values", async () => {
    const store = new MemoryStore();
    expect(await store.incr("n", 1000)).toBe(1);
    expect(await store.incr("n")).toBe(2);
    expect(await store.incr("n")).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(await store.get("n")).toBeUndefined();
    await store.set("s", "nope");
    await expect(store.incr("s")).rejects.toEqual(
      expect.objectContaining({ code: "HORS_UNAVAILABLE" }),
    );
  });

  it("consumes a key once per TTL window, independently per key", async () => {
    const store = new MemoryStore();
    expect(await store.consumeOnce("nonce:a", 1000)).toBe(true);
    expect(await store.consumeOnce("nonce:a", 1000)).toBe(false);
    expect(await store.consumeOnce("call:b", 1000)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(await store.consumeOnce("nonce:a", 1000)).toBe(true);
  });

  it("rejects non-positive or non-finite ttlMs", async () => {
    const store = new MemoryStore();
    await expect(store.consumeOnce("k", 0)).rejects.toEqual(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    await expect(store.set("k", 1, -1)).rejects.toEqual(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    await expect(store.incr("k", Number.NaN)).rejects.toEqual(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    await store.set("ok", 1, 1);
    expect(await store.get("ok")).toBe(1);
  });

  it("sweeps expired entries every 1000 mutating calls", async () => {
    const store = new MemoryStore();
    await store.set("stale", 1, 1000);
    vi.advanceTimersByTime(2000);
    for (let i = 0; i < 1000; i += 1) {
      await store.set(`k${i}`, i);
    }
    expect(store.size).toBe(1000);
  });
});
