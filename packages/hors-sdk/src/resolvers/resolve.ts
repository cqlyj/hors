import { echo, HorsError } from "../errors.js";
import { hasControlCharacter } from "../plain.js";
import { httpUrlWithoutCredentials } from "../url.js";
import { ens } from "./ens.js";
import { ERC8004_URI, erc8004 } from "./erc8004.js";
import type { ResolveOptions } from "./types.js";

const BARE_ENS = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/;
const ENS_URI = /^ens:[^\s]+$/;

export function classifyService(value: string): "url" | "ens" | "erc8004" | undefined {
  if (httpUrlWithoutCredentials(value) !== undefined) {
    return "url";
  }
  if (ERC8004_URI.test(value)) {
    return "erc8004";
  }
  if ((ENS_URI.test(value) && !hasControlCharacter(value)) || BARE_ENS.test(value)) {
    return "ens";
  }
  return undefined;
}

async function interpret(value: string, options?: ResolveOptions): Promise<string> {
  const kind = classifyService(value);
  if (kind === "url") {
    return value;
  }
  if (kind === "ens") {
    const name = value.startsWith("ens:") ? value.slice(4) : value;
    return cached(value.startsWith("ens:") ? value : `ens:${value}`, options, () =>
      ens(name, options),
    );
  }
  if (kind === "erc8004") {
    return cached(value, options, () => erc8004(value, options));
  }
  throw new HorsError("RESOLVER_FAILED", `unknown service: ${echo(value)}`);
}

async function cached(
  uri: string,
  options: ResolveOptions | undefined,
  resolveFresh: () => Promise<string>,
): Promise<string> {
  if (options?.cache === false) {
    return resolveFresh();
  }
  const { cacheHit, cacheHome, readResolveCache, writeResolveCache } = await import("./cache.js");
  const home = cacheHome(options);
  const now = Date.now();
  try {
    const hit = cacheHit((await readResolveCache(home))[uri], now, options?.refresh);
    if (hit !== undefined) {
      return hit;
    }
  } catch {
    // ignore corrupt/unreadable cache
  }
  const url = await resolveFresh();
  await writeResolveCache(home, uri, url, now);
  return url;
}

export async function resolve(service: string, options?: ResolveOptions): Promise<string> {
  if (options?.services !== undefined && Object.hasOwn(options.services, service)) {
    const mapped = options.services[service];
    if (typeof mapped !== "string") {
      throw new HorsError("CONFIG_INVALID", "services values must be strings");
    }
    return interpret(mapped, options);
  }
  if (options?.cache !== false) {
    const { cacheHome, readAddressBook } = await import("./cache.js");
    const book = await readAddressBook(cacheHome(options));
    if (Object.hasOwn(book, service)) {
      const mapped = book[service];
      if (mapped !== undefined) {
        return interpret(mapped, options);
      }
    }
  }
  return interpret(service, options);
}
