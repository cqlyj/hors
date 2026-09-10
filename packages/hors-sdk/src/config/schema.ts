import { echo, HorsError } from "../errors.js";
import {
  type Address,
  type HumanId,
  isAddress,
  isChainId,
  normalizeAddress,
  parseHumanId,
} from "../identity.js";
import { compilePolicy } from "../policy/registry.js";
import type { CompiledPolicy, Policy } from "../policy/types.js";
import type { Store } from "../store.js";
import { httpUrlWithoutCredentials } from "../url.js";
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_MAX_AGE_MS } from "../verify/verify.js";
import type { AgentBookCache } from "../world/agentbook.js";
import { PROFILE_NAME } from "./profile-name.js";
import {
  invalid,
  nestedObject,
  rejectUnknown,
  requireHttpUrl,
  requireIntegerInRange,
  requireNonNegativeFinite,
  requirePlainObject,
  requirePositiveDuration,
} from "./validators.js";

export interface HorsConfig {
  owner?: "auto" | HumanId;
  profile?: string;
  policy?: Policy;
  functions?: Record<string, Policy>;
  deny?: Address[];
  local?: "same-human" | "deny";
  origins?: string[];
  trustProxy?: boolean;
  maxAgeMs?: number;
  clockSkewMs?: number;
  ruleTimeoutMs?: number;
  rpc?: { worldchain?: string; ens?: string; signatures?: Record<string, string> };
  cache?: AgentBookCache;
  store?: Store;
  services?: Record<string, string>;
  dev?: { mockOrigin?: boolean };
}

export function defineConfig(config: HorsConfig): HorsConfig {
  return config;
}

export interface GateConfig {
  readonly owner: "auto" | HumanId;
  readonly profile: string;
  readonly policy: CompiledPolicy;
  readonly functions: ReadonlyMap<string, CompiledPolicy>;
  readonly deny: ReadonlySet<Address>;
  readonly local: "same-human" | "deny";
  readonly origins: readonly string[] | undefined;
  readonly trustProxy: boolean;
  readonly maxAgeMs: number;
  readonly clockSkewMs: number;
  readonly ruleTimeoutMs: number;
  readonly rpc: {
    readonly worldchain: string | undefined;
    readonly ens: string | undefined;
    readonly signatures: Readonly<Record<string, string>>;
  };
  readonly cache: AgentBookCache;
  readonly store: Store | undefined;
  readonly services: Readonly<Record<string, string>>;
  readonly mock: boolean;
}

const DEFAULT_RULE_TIMEOUT_MS = 10_000;
const ORIGIN_RULE = "origins entries must be http(s) URLs without query, fragment or credentials";

const CONFIG_KEYS = new Set([
  "owner",
  "profile",
  "policy",
  "functions",
  "deny",
  "local",
  "origins",
  "trustProxy",
  "maxAgeMs",
  "clockSkewMs",
  "ruleTimeoutMs",
  "rpc",
  "cache",
  "store",
  "services",
  "dev",
]);

function isStore(value: object): value is Store {
  return (["get", "set", "incr", "consumeOnce", "delete"] as const).every(
    (method) => typeof Reflect.get(value, method) === "function",
  );
}

function compileFunctions(raw: unknown): Map<string, CompiledPolicy> {
  const functions = new Map<string, CompiledPolicy>();
  if (raw === undefined) {
    return functions;
  }
  for (const [fn, policy] of Object.entries(
    requirePlainObject(raw, "functions", "functions must be a plain object of policies"),
  )) {
    if (fn === "") {
      invalid("functions keys must be non-empty");
    }
    try {
      functions.set(fn, compilePolicy(policy));
    } catch (error) {
      if (error instanceof HorsError) {
        invalid(`functions[${echo(fn)}]: ${error.message}`);
      }
      throw error;
    }
  }
  return functions;
}

function compileOrigins(raw: unknown): string[] | undefined {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    invalid(ORIGIN_RULE);
  }
  return raw.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.includes("?") ||
      entry.includes("#") ||
      httpUrlWithoutCredentials(entry) === undefined
    ) {
      invalid(ORIGIN_RULE);
    }
    return entry;
  });
}

export function validateConfig(
  value: unknown,
  options: { readonly nodeEnv: string | undefined },
): GateConfig {
  const raw = requirePlainObject(value, "config", "config must be a plain object");
  rejectUnknown(raw, CONFIG_KEYS, "");

  const owner: "auto" | HumanId =
    raw.owner === undefined || raw.owner === "auto"
      ? "auto"
      : (parseHumanId(raw.owner) ?? invalid('owner must be "auto" or a humanId'));
  if (
    raw.profile !== undefined &&
    (typeof raw.profile !== "string" || !PROFILE_NAME.test(raw.profile))
  ) {
    invalid("profile must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }

  const deny = new Set<Address>();
  if (raw.deny !== undefined) {
    if (!Array.isArray(raw.deny)) {
      invalid("deny must be an array of addresses");
    }
    raw.deny.forEach((entry, index) => {
      if (isAddress(entry)) {
        deny.add(normalizeAddress(entry));
      } else {
        invalid(`deny[${index}]: address must be a 20-byte 0x-prefixed hex string`);
      }
    });
  }

  const local = raw.local === undefined ? "same-human" : raw.local;
  if (local !== "same-human" && local !== "deny") {
    invalid('local must be "same-human" or "deny"');
  }
  if (raw.trustProxy !== undefined && typeof raw.trustProxy !== "boolean") {
    invalid("trustProxy must be a boolean");
  }

  const maxAgeMs =
    raw.maxAgeMs === undefined
      ? DEFAULT_MAX_AGE_MS
      : requirePositiveDuration(raw.maxAgeMs, "maxAgeMs");
  const clockSkewMs =
    raw.clockSkewMs === undefined
      ? DEFAULT_CLOCK_SKEW_MS
      : requireNonNegativeFinite(raw.clockSkewMs, "clockSkewMs");
  const ruleTimeoutMs =
    raw.ruleTimeoutMs === undefined
      ? DEFAULT_RULE_TIMEOUT_MS
      : requireIntegerInRange(raw.ruleTimeoutMs, "ruleTimeoutMs", 1, 2_147_483_647);
  if (!Number.isFinite(maxAgeMs + clockSkewMs)) {
    invalid("maxAgeMs + clockSkewMs must be finite");
  }

  let worldchain: string | undefined;
  let ens: string | undefined;
  const signatureEntries: Array<[string, string]> = [];
  if (raw.rpc !== undefined) {
    const rpc = nestedObject(raw.rpc, "rpc", ["worldchain", "ens", "signatures"]);
    if (rpc.worldchain !== undefined) {
      worldchain = requireHttpUrl(rpc.worldchain, "rpc.worldchain");
    }
    if (rpc.ens !== undefined) {
      ens = requireHttpUrl(rpc.ens, "rpc.ens");
    }
    if (rpc.signatures !== undefined) {
      for (const [key, url] of Object.entries(
        requirePlainObject(rpc.signatures, "rpc.signatures"),
      )) {
        if (!isChainId(key)) {
          invalid("rpc.signatures keys must be eip155:<chain-id>");
        }
        signatureEntries.push([key, requireHttpUrl(url, `rpc.signatures[${echo(key)}]`)]);
      }
    }
  }

  const cache: AgentBookCache = {};
  if (raw.cache !== undefined) {
    const rawCache = nestedObject(raw.cache, "cache", ["humanTtlMs", "nullTtlMs", "staleTtlMs"]);
    for (const key of ["humanTtlMs", "nullTtlMs", "staleTtlMs"] as const) {
      if (rawCache[key] !== undefined) {
        cache[key] = requirePositiveDuration(rawCache[key], `cache.${key}`);
      }
    }
  }

  let store: Store | undefined;
  if (raw.store !== undefined) {
    if (raw.store === null || typeof raw.store !== "object" || !isStore(raw.store)) {
      invalid("store must implement Store");
    }
    store = raw.store;
  }

  const serviceEntries: Array<[string, string]> = [];
  if (raw.services !== undefined) {
    for (const [name, endpoint] of Object.entries(
      requirePlainObject(raw.services, "services", "services must map names to non-empty strings"),
    )) {
      if (name === "" || typeof endpoint !== "string" || endpoint === "") {
        invalid("services must map names to non-empty strings");
      }
      serviceEntries.push([name, endpoint]);
    }
  }

  let mock = false;
  if (raw.dev !== undefined) {
    const dev = nestedObject(raw.dev, "dev", ["mockOrigin"]);
    if (dev.mockOrigin !== undefined && typeof dev.mockOrigin !== "boolean") {
      invalid("dev.mockOrigin must be a boolean");
    }
    mock = dev.mockOrigin === true;
    if (mock && options.nodeEnv === "production") {
      invalid("dev.mockOrigin is not allowed when NODE_ENV is production");
    }
  }

  return {
    owner,
    profile: raw.profile === undefined ? "default" : raw.profile,
    policy: raw.policy === undefined ? compilePolicy("same-human") : compilePolicy(raw.policy),
    functions: compileFunctions(raw.functions),
    deny,
    local,
    origins: compileOrigins(raw.origins),
    trustProxy: raw.trustProxy === true,
    maxAgeMs,
    clockSkewMs,
    ruleTimeoutMs,
    rpc: { worldchain, ens, signatures: Object.fromEntries(signatureEntries) },
    cache,
    store,
    services: Object.fromEntries(serviceEntries),
    mock,
  };
}
