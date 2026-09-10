import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/schema.js";
import { HorsError } from "../src/errors.js";
import { normalizeAddress, normalizeHumanId } from "../src/identity.js";
import { compilePolicy } from "../src/policy/registry.js";

const ADDR = "0xAbC0000000000000000000000000000000000001";
const ADDR_LOWER = normalizeAddress(ADDR);

function expectConfigInvalid(input: unknown, substring: string, nodeEnv?: string): HorsError {
  try {
    validateConfig(input, { nodeEnv });
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("CONFIG_INVALID");
    expect((error as HorsError).message).toContain(substring);
    return error as HorsError;
  }
  expect.unreachable();
}

describe("validateConfig", () => {
  it("applies defaults for an empty object", () => {
    const config = validateConfig({}, { nodeEnv: undefined });
    const policy = compilePolicy("same-human");
    expect(config.owner).toBe("auto");
    expect(config.profile).toBe("default");
    expect(config.policy.name).toBe(policy.name);
    expect([...config.policy.origin]).toEqual([...policy.origin]);
    expect(config.functions).toEqual(new Map());
    expect(config.deny).toEqual(new Set());
    expect(config.local).toBe("same-human");
    expect(config.origins).toBeUndefined();
    expect(config.trustProxy).toBe(false);
    expect(config.maxAgeMs).toBe(300_000);
    expect(config.clockSkewMs).toBe(30_000);
    expect(config.ruleTimeoutMs).toBe(10_000);
    expect(config.rpc).toEqual({ worldchain: undefined, ens: undefined, signatures: {} });
    expect(config.cache).toEqual({});
    expect(config.store).toBeUndefined();
    expect(config.services).toEqual({});
    expect(config.mock).toBe(false);
  });

  it("normalises owner, deny, origins, functions, rpc.signatures and cache", () => {
    const signatures = { "eip155:1": "https://a.example" };
    const functions = { b: "public" as const, a: "any-human" as const };
    const config = validateConfig(
      {
        owner: "0xABC",
        deny: [ADDR, ADDR.toLowerCase()],
        origins: [],
        functions,
        rpc: { signatures },
        cache: { humanTtlMs: 5 },
      },
      { nodeEnv: undefined },
    );
    expect(config.owner).toBe(normalizeHumanId("0xABC"));
    expect(config.deny).toEqual(new Set([ADDR_LOWER]));
    expect(config.deny.size).toBe(1);
    expect(config.origins).toBeUndefined();
    expect([...config.functions.keys()]).toEqual(["b", "a"]);
    expect(config.functions.get("b")?.origin).toEqual(compilePolicy("public").origin);
    expect(config.functions.get("a")?.origin).toEqual(compilePolicy("any-human").origin);
    expect(config.rpc.signatures).toEqual(signatures);
    expect(config.rpc.signatures).not.toBe(signatures);
    expect(config.cache).toEqual({ humanTtlMs: 5 });
  });

  it("keeps __proto__ and constructor function keys on the functions Map", () => {
    const config = validateConfig(
      { functions: JSON.parse('{"__proto__":"public","constructor":"any-human"}') },
      { nodeEnv: undefined },
    );
    expect(config.functions.get("__proto__")?.name).toBe("public");
    expect(config.functions.get("constructor")?.name).toBe("any-human");
  });

  it("keeps a service named __proto__ as an own key", () => {
    const config = validateConfig(
      { services: JSON.parse('{"__proto__":"x","a":"b"}') },
      { nodeEnv: undefined },
    );
    expect(Object.hasOwn(config.services, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(config.services)).toBe(Object.prototype);
    expect(config.services.a).toBe("b");
  });

  it("accepts an RPC URL with a query and the maximum ruleTimeoutMs", () => {
    const config = validateConfig(
      {
        rpc: { signatures: { "eip155:1": "https://a/?key=secret" } },
        ruleTimeoutMs: 2 ** 31 - 1,
        clockSkewMs: 0,
      },
      { nodeEnv: undefined },
    );
    expect(config.rpc.signatures["eip155:1"]).toBe("https://a/?key=secret");
    expect(config.ruleTimeoutMs).toBe(2 ** 31 - 1);
    expect(config.clockSkewMs).toBe(0);
  });

  it("enables mock mode outside production", () => {
    expect(validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: "test" }).mock).toBe(true);
    expect(validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }).mock).toBe(true);
    expectConfigInvalid(
      { dev: { mockOrigin: true } },
      "dev.mockOrigin is not allowed when NODE_ENV is production",
      "production",
    );
  });

  it.each([
    { input: null, message: "config must be a plain object" },
    { input: [], message: "config must be a plain object" },
    { input: "x", message: "config must be a plain object" },
    { input: new (class {})(), message: "config must be a plain object" },
    { input: { nope: 1 }, message: "unknown config key nope" },
    {
      input: JSON.parse('{"__proto__":{"polluted":1},"owner":"auto"}'),
      message: "unknown config key __proto__",
    },
    {
      input: JSON.parse('{"rpc":{"__proto__":{"x":1}}}'),
      message: "unknown config key rpc.__proto__",
    },
    { input: { rpc: { nope: 1 } }, message: "unknown config key rpc.nope" },
    { input: { dev: { nope: 1 } }, message: "unknown config key dev.nope" },
    { input: { cache: { nope: 1 } }, message: "unknown config key cache.nope" },
    { input: { owner: "xyz" }, message: 'owner must be "auto" or a humanId' },
    { input: { owner: 1 }, message: 'owner must be "auto" or a humanId' },
    { input: { owner: "0x0" }, message: 'owner must be "auto" or a humanId' },
    { input: { profile: "" }, message: "profile must match" },
    { input: { profile: "." }, message: "profile must match" },
    { input: { profile: ".." }, message: "profile must match" },
    { input: { profile: "a/b" }, message: "profile must match" },
    { input: { profile: "a\\b" }, message: "profile must match" },
    { input: { profile: ".hidden" }, message: "profile must match" },
    { input: { profile: "x".repeat(65) }, message: "profile must match" },
    { input: { profile: 1 }, message: "profile must match" },
    { input: { policy: "nope" }, message: "unknown policy nope" },
    { input: { functions: { f: "nope" } }, message: "functions[f]: unknown policy nope" },
    { input: { functions: { "": "public" } }, message: "functions keys must be non-empty" },
    { input: { functions: { f: 1 } }, message: "functions[f]: policy must be a plain object" },
    { input: { functions: [] }, message: "functions must be a plain object of policies" },
    { input: { deny: ADDR }, message: "deny must be an array of addresses" },
    { input: { deny: ["nope"] }, message: "deny[0]: address must be" },
    { input: { local: "public" }, message: 'local must be "same-human" or "deny"' },
    { input: { origins: "https://x" }, message: "origins entries must be http(s) URLs" },
    { input: { origins: ["https://x/?a=1"] }, message: "origins entries must be http(s) URLs" },
    { input: { origins: ["https://x/#f"] }, message: "origins entries must be http(s) URLs" },
    { input: { origins: ["ftp://x"] }, message: "origins entries must be http(s) URLs" },
    { input: { origins: ["https://u:p@x/"] }, message: "origins entries must be http(s) URLs" },
    { input: { origins: ["not a url"] }, message: "origins entries must be http(s) URLs" },
    { input: { origins: [1] }, message: "origins entries must be http(s) URLs" },
    { input: { trustProxy: "yes" }, message: "trustProxy must be a boolean" },
    { input: { maxAgeMs: 0 }, message: "maxAgeMs must be a positive finite number" },
    { input: { maxAgeMs: -1 }, message: "maxAgeMs must be a positive finite number" },
    { input: { maxAgeMs: Number.NaN }, message: "maxAgeMs must be a positive finite number" },
    {
      input: { maxAgeMs: Number.POSITIVE_INFINITY },
      message: "maxAgeMs must be a positive finite number",
    },
    { input: { maxAgeMs: "5" }, message: "maxAgeMs must be a positive finite number" },
    { input: { maxAgeMs: 1n }, message: "maxAgeMs must be a positive finite number" },
    {
      input: { maxAgeMs: 1e308, clockSkewMs: 1e308 },
      message: "maxAgeMs + clockSkewMs must be finite",
    },
    {
      input: { ruleTimeoutMs: 0 },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    {
      input: { ruleTimeoutMs: -1 },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    {
      input: { ruleTimeoutMs: Number.NaN },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    {
      input: { ruleTimeoutMs: Number.POSITIVE_INFINITY },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    {
      input: { ruleTimeoutMs: "5" },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    {
      input: { ruleTimeoutMs: 1n },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    {
      input: { ruleTimeoutMs: 0.5 },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    {
      input: { ruleTimeoutMs: 2 ** 31 },
      message: "ruleTimeoutMs must be an integer between 1 and 2147483647",
    },
    { input: { clockSkewMs: -1 }, message: "clockSkewMs must be a finite number ≥ 0" },
    { input: { clockSkewMs: Number.NaN }, message: "clockSkewMs must be a finite number ≥ 0" },
    { input: { clockSkewMs: "5" }, message: "clockSkewMs must be a finite number ≥ 0" },
    {
      input: { cache: { humanTtlMs: 0 } },
      message: "cache.humanTtlMs must be a positive finite number",
    },
    {
      input: { cache: { nullTtlMs: 0 } },
      message: "cache.nullTtlMs must be a positive finite number",
    },
    {
      input: { cache: { staleTtlMs: 0 } },
      message: "cache.staleTtlMs must be a positive finite number",
    },
    { input: { cache: 1 }, message: "cache must be a plain object" },
    { input: { rpc: "https://x" }, message: "rpc must be a plain object" },
    { input: { rpc: { worldchain: "ftp://x" } }, message: "rpc.worldchain must be an http(s) URL" },
    { input: { rpc: { signatures: 1 } }, message: "rpc.signatures must be a plain object" },
    {
      input: { rpc: { signatures: { "eip155:0": "https://x" } } },
      message: "rpc.signatures keys must be eip155:",
    },
    {
      input: { rpc: { signatures: { "eip155:01": "https://x" } } },
      message: "rpc.signatures keys must be eip155:",
    },
    {
      input: { rpc: { signatures: { "1": "https://x" } } },
      message: "rpc.signatures keys must be eip155:",
    },
    {
      input: { rpc: { signatures: { constructor: "https://x" } } },
      message: "rpc.signatures keys must be eip155:",
    },
    {
      input: { rpc: { signatures: { "eip155:1": "nope" } } },
      message: "rpc.signatures[eip155:1] must be an http(s) URL",
    },
    {
      input: { rpc: { signatures: { "eip155:9007199254740993": "https://x" } } },
      message: "rpc.signatures keys must be eip155:",
    },
    { input: { store: {} }, message: "store must implement Store" },
    { input: { store: { get() {} } }, message: "store must implement Store" },
    { input: { services: { a: 1 } }, message: "services must map names to non-empty strings" },
    { input: { services: { "": "x" } }, message: "services must map names to non-empty strings" },
    { input: { dev: { mockOrigin: "1" } }, message: "dev.mockOrigin must be a boolean" },
    { input: { dev: [] }, message: "dev must be a plain object" },
  ] satisfies ReadonlyArray<{ input: unknown; message: string }>)(
    "rejects: $message",
    ({ input, message }) => {
      expectConfigInvalid(input, message);
    },
  );

  it("truncates a long unknown config key to 64 characters", () => {
    const key = "k".repeat(300);
    const error = expectConfigInvalid({ [key]: 1 }, "unknown config key");
    expect(error.message).toContain("k".repeat(64));
    expect(error.message).not.toContain("k".repeat(65));
  });
});
