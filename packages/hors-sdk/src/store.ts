import { HorsError } from "./errors.js";

export interface Store {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  incr(key: string, ttlMs?: number): Promise<number>; // returns new value; sets TTL on first increment
  consumeOnce(key: string, ttlMs: number): Promise<boolean>; // true exactly once per key within TTL
  delete(key: string): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number | undefined;
}

function requireTtlMs(ttlMs: number): void {
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) {
    throw new HorsError("CONFIG_INVALID", "store: ttlMs must be a positive finite number");
  }
}

export class MemoryStore implements Store {
  readonly #entries = new Map<string, Entry>();
  #mutations = 0;

  // MemoryStore-only, for tests and diagnostics, not part of Store.
  get size(): number {
    return this.#entries.size;
  }

  #expired(entry: Entry, now: number): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= now;
  }

  #read(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.#expired(entry, Date.now())) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (this.#expired(entry, now)) {
        this.#entries.delete(key);
      }
    }
  }

  // Counts successful writes — set, a first incr, a consumeOnce that returned
  // true; a rejected replay adds no entry, so there is nothing new to sweep —
  // so a Redis port does not "fix" it.
  #touch(): void {
    this.#mutations += 1;
    if (this.#mutations % 1000 === 0) {
      this.#sweep(Date.now());
    }
  }

  async get(key: string): Promise<unknown | undefined> {
    return this.#read(key)?.value;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      requireTtlMs(ttlMs);
    }
    const expiresAt = ttlMs === undefined ? undefined : Date.now() + ttlMs;
    this.#entries.set(key, { value, expiresAt });
    this.#touch();
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    if (ttlMs !== undefined) {
      requireTtlMs(ttlMs);
    }
    const entry = this.#read(key);
    if (entry === undefined) {
      const expiresAt = ttlMs === undefined ? undefined : Date.now() + ttlMs;
      this.#entries.set(key, { value: 1, expiresAt });
      this.#touch();
      return 1;
    }
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      throw new HorsError("HORS_UNAVAILABLE", "store: incr on a non-numeric value");
    }
    const next = entry.value + 1;
    entry.value = next;
    this.#touch();
    return next;
  }

  async consumeOnce(key: string, ttlMs: number): Promise<boolean> {
    requireTtlMs(ttlMs);
    // Check and write are synchronous so a single-process consumeOnce is atomic.
    if (this.#read(key) !== undefined) {
      return false;
    }
    this.#entries.set(key, { value: true, expiresAt: Date.now() + ttlMs });
    this.#touch();
    return true;
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }
}
