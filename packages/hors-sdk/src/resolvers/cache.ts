import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAddressBook } from "../config/address-book.js";
import { profileHome } from "../config/profile.js";
import { isPlainObject } from "../plain.js";
import type { ResolveCache, ResolveOptions } from "./types.js";

export { readAddressBook };

export function cacheHome(options?: ResolveOptions): string {
  if (options?.cache && typeof options.cache === "object" && options.cache.home !== undefined) {
    return options.cache.home;
  }
  return profileHome();
}

function asCacheEntry(
  value: unknown,
  now: number,
): { readonly url: string; readonly at: number } | undefined {
  if (!isPlainObject(value) || typeof value.url !== "string" || typeof value.at !== "number") {
    return undefined;
  }
  if (!Number.isFinite(value.at) || value.at > now) {
    return undefined;
  }
  return { url: value.url, at: value.at };
}

export async function readResolveCache(home: string): Promise<ResolveCache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, "cache", "resolve.json"), "utf8"));
    if (!isPlainObject(parsed)) {
      return {};
    }
    const now = Date.now();
    const cache: Record<string, { readonly url: string; readonly at: number }> = {};
    for (const [uri, value] of Object.entries(parsed)) {
      const entry = asCacheEntry(value, now);
      if (entry !== undefined) {
        cache[uri] = entry;
      }
    }
    return cache;
  } catch {
    return {};
  }
}

export function cacheHit(
  entry: { readonly url: string; readonly at: number } | undefined,
  now: number,
  refresh?: boolean,
): string | undefined {
  if (refresh || entry === undefined || now - entry.at >= 3_600_000) {
    return undefined;
  }
  return entry.url;
}

export async function writeResolveCache(
  home: string,
  uri: string,
  url: string,
  now: number,
): Promise<void> {
  try {
    const dir = join(home, "cache");
    await mkdir(dir, { mode: 0o700, recursive: true });
    const current = { ...(await readResolveCache(home)), [uri]: { url, at: now } };
    const tmp = join(dir, "resolve.json.tmp");
    await writeFile(tmp, JSON.stringify(current));
    await rename(tmp, join(dir, "resolve.json"));
  } catch {
    // Cache failures never fail a resolution.
  }
}
