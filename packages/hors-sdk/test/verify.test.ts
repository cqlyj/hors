import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { argsUrn, functionUrn } from "../src/binding.js";
import { HorsError } from "../src/errors.js";
import { hashArgs } from "../src/hash.js";
import { type Address, normalizeAddress, normalizeHumanId } from "../src/identity.js";
import { MemoryStore } from "../src/store.js";
import type { SignatureVerifier } from "../src/verify/signature.js";
import {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_MAX_AGE_MS,
  type VerifyDeps,
  type VerifyInput,
  verifyCaller,
} from "../src/verify/verify.js";
import type { AgentBook } from "../src/world/agentbook.js";
import { DEFAULT_ARGS_HASH, DEFAULT_FN, signedEnvelope, testAccount } from "./helpers/sign.js";

const T0 = Date.parse("2026-09-08T02:15:30.123Z");
const HUMAN = normalizeHumanId(0xabcn);
const EXPECTED = [{ host: "work.example.com", path: "/mcp" }] as const;

function expectCode(error: unknown, code: string): asserts error is HorsError {
  expect(error).toBeInstanceOf(HorsError);
  expect((error as HorsError).code).toBe(code);
}

describe("verifyCaller", () => {
  const account = testAccount();
  const lookupHuman = vi.fn<(address: Address) => Promise<typeof HUMAN | null>>();
  const signatureVerifier = vi.fn<(chainId: string) => SignatureVerifier | undefined>();
  const agentBook: AgentBook = {
    lookupHuman,
    getNextNonce: vi.fn(async () => 1n),
  };

  let store: MemoryStore;
  let deps: VerifyDeps;

  function input(auth: unknown, patch?: Partial<VerifyInput>): VerifyInput {
    return {
      auth,
      fn: DEFAULT_FN,
      argsHash: DEFAULT_ARGS_HASH,
      expected: EXPECTED,
      publicOrigin: false,
      now: T0,
      ...patch,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    lookupHuman.mockReset();
    lookupHuman.mockResolvedValue(HUMAN);
    signatureVerifier.mockReset();
    signatureVerifier.mockReturnValue(undefined);
    store = new MemoryStore();
    deps = {
      store,
      agentBook,
      deny: new Set(),
      signatureVerifier,
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      clockSkewMs: DEFAULT_CLOCK_SKEW_MS,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a valid envelope and returns a signed caller", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 });
    const caller = await verifyCaller(input(raw), deps);
    expect(caller).toEqual({
      kind: "signed",
      address: normalizeAddress(account.address),
      humanId: HUMAN,
      chainId: "eip155:480",
      callId: raw.requestId,
    });
    expect(signatureVerifier).not.toHaveBeenCalled();
  });

  it("treats only undefined auth as absent (step 1)", async () => {
    await expect(verifyCaller(input(undefined, { publicOrigin: true }), deps)).resolves.toEqual({
      kind: "anonymous",
    });
    expect(lookupHuman).not.toHaveBeenCalled();
    expect(store.size).toBe(0);

    await expect(verifyCaller(input(undefined), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_UNSIGNED");
      return true;
    });
    await expect(verifyCaller(input(null), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_BAD_ENVELOPE");
      return true;
    });
    await expect(verifyCaller(input({ nonsense: true }), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_BAD_ENVELOPE");
      return true;
    });
  });

  it("rejects domain and path mismatches (step 3) before any store write", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 });
    await expect(
      verifyCaller(input(raw, { expected: [{ host: "other.example.com", path: "/mcp" }] }), deps),
    ).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_DOMAIN_MISMATCH");
      return true;
    });
    await expect(
      verifyCaller(input(raw, { expected: [{ host: "work.example.com", path: "/other" }] }), deps),
    ).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_DOMAIN_MISMATCH");
      return true;
    });
    expect(lookupHuman).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("enforces issuedAt, clock skew and expirationTime boundaries (step 4)", async () => {
    const old = await signedEnvelope(account, {
      now: T0,
      fields: {
        issuedAt: new Date(T0 - 300_000).toISOString(),
        expirationTime: new Date(T0 + 120_000).toISOString(),
      },
    });
    await expect(verifyCaller(input(old.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_EXPIRED");
      return true;
    });

    const justFresh = await signedEnvelope(account, {
      now: T0,
      fields: {
        issuedAt: new Date(T0 - 299_999).toISOString(),
        expirationTime: new Date(T0 + 120_000).toISOString(),
      },
    });
    await expect(verifyCaller(input(justFresh.raw), deps)).resolves.toMatchObject({
      kind: "signed",
    });

    const tooFuture = await signedEnvelope(account, { now: T0 + 30_001 });
    await expect(verifyCaller(input(tooFuture.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_EXPIRED");
      return true;
    });

    const skewOk = await signedEnvelope(account, { now: T0 + 30_000 });
    await expect(verifyCaller(input(skewOk.raw), deps)).resolves.toMatchObject({ kind: "signed" });

    const expired = await signedEnvelope(account, {
      now: T0,
      fields: { expirationTime: new Date(T0).toISOString() },
    });
    await expect(verifyCaller(input(expired.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_EXPIRED");
      return true;
    });

    deps = { ...deps, maxAgeMs: 1_000 };
    const customOld = await signedEnvelope(account, {
      now: T0,
      fields: {
        issuedAt: new Date(T0 - 1_000).toISOString(),
        expirationTime: new Date(T0 + 120_000).toISOString(),
      },
    });
    await expect(verifyCaller(input(customOld.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_EXPIRED");
      return true;
    });
  });

  it("closes the replay window when the store entry expires (step 4 / 9)", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 + 30_000 });
    await verifyCaller(input(raw, { now: T0 }), deps);
    vi.setSystemTime(T0 + 330_000);
    await expect(verifyCaller(input(raw, { now: T0 + 330_000 }), deps)).rejects.toSatisfy(
      (error) => {
        expectCode(error, "HORS_EXPIRED");
        return true;
      },
    );
  });

  it("rejects an unsupported version, function and args hash (steps 5–7)", async () => {
    const version = await signedEnvelope(account, {
      now: T0,
      fields: {
        resources: ["urn:hors:v:2", functionUrn(DEFAULT_FN), argsUrn(DEFAULT_ARGS_HASH)],
      },
    });
    await expect(verifyCaller(input(version.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_VERSION");
      return true;
    });

    const { raw } = await signedEnvelope(account, { now: T0 });
    await expect(verifyCaller(input(raw, { fn: "otherFunction" }), deps)).rejects.toSatisfy(
      (error) => {
        expectCode(error, "HORS_FUNCTION_MISMATCH");
        return true;
      },
    );

    const httpFn = await signedEnvelope(account, { now: T0, fn: "POST /approve" });
    await expect(
      verifyCaller(input(httpFn.raw, { fn: "POST /approve" }), deps),
    ).resolves.toMatchObject({ kind: "signed" });

    const wrongArgs = await hashArgs({ amount: 851, currency: "EUR" });
    await expect(verifyCaller(input(raw, { argsHash: wrongArgs }), deps)).rejects.toSatisfy(
      (error) => {
        expectCode(error, "HORS_ARGS_MISMATCH");
        return true;
      },
    );
  });

  it("verifies eip191 offline and eip1271 through the chain RPC (step 8)", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 });
    const tampered = { ...raw, signature: `0x${"22".repeat(65)}` };
    await expect(verifyCaller(input(tampered), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_BAD_SIGNATURE");
      expect(error.message).not.toContain(String(raw.nonce));
      expect(error.message).not.toContain(String(raw.requestId));
      expect(error.message).not.toContain(String(raw.signature));
      return true;
    });
    expect(store.size).toBe(0);
    expect(lookupHuman).not.toHaveBeenCalled();

    const eip1271 = await signedEnvelope(account, { now: T0, fields: { type: "eip1271" } });
    await expect(verifyCaller(input(eip1271.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_UNAVAILABLE");
      return true;
    });

    const ok: SignatureVerifier = { verifyMessage: vi.fn(async () => true) };
    signatureVerifier.mockReturnValue(ok);
    await expect(verifyCaller(input(eip1271.raw), deps)).resolves.toMatchObject({ kind: "signed" });
    expect(signatureVerifier).toHaveBeenCalledWith("eip155:480");
  });

  it("consumes nonce and callId only after a valid signature (step 9)", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 });
    await verifyCaller(input(raw), deps);
    await expect(verifyCaller(input(raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_REPLAY");
      return true;
    });

    const nonceReuse = await signedEnvelope(account, {
      now: T0,
      fields: { nonce: raw.nonce },
    });
    await expect(verifyCaller(input(nonceReuse.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_REPLAY");
      return true;
    });

    const callReuse = await signedEnvelope(account, {
      now: T0,
      fields: { requestId: raw.requestId },
    });
    await expect(verifyCaller(input(callReuse.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_REPLAY");
      return true;
    });

    const failed = await signedEnvelope(account, { now: T0 });
    await expect(
      verifyCaller(input({ ...failed.raw, signature: `0x${"22".repeat(65)}` }), deps),
    ).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_BAD_SIGNATURE");
      return true;
    });
    await expect(verifyCaller(input(failed.raw), deps)).resolves.toMatchObject({ kind: "signed" });

    const fresh = await signedEnvelope(account, { now: T0 });
    await verifyCaller(input(fresh.raw), deps);
    expect(await store.get(`nonce:${String(fresh.raw.nonce)}`)).toBeDefined();
    vi.setSystemTime(T0 + 330_001);
    expect(await store.get(`nonce:${String(fresh.raw.nonce)}`)).toBeUndefined();
  });

  it("denies listed wallets before AgentBook (step 10) and handles registration (step 11)", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 });
    deps = { ...deps, deny: new Set([normalizeAddress(account.address)]) };
    await expect(verifyCaller(input(raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_DENIED_WALLET");
      return true;
    });
    expect(lookupHuman).not.toHaveBeenCalled();
    expect(await store.get(`nonce:${String(raw.nonce)}`)).toBeDefined();

    deps = { ...deps, deny: new Set() };
    lookupHuman.mockResolvedValue(null);
    const unregistered = await signedEnvelope(account, { now: T0 });
    await expect(verifyCaller(input(unregistered.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_NOT_HUMAN");
      return true;
    });
    const unregisteredPublic = await signedEnvelope(account, { now: T0 });
    await expect(
      verifyCaller(input(unregisteredPublic.raw, { publicOrigin: true }), deps),
    ).resolves.toMatchObject({ kind: "signed", humanId: null });

    const unavailable = new HorsError("HORS_UNAVAILABLE", "AgentBook lookup failed");
    lookupHuman.mockRejectedValue(unavailable);
    const later = await signedEnvelope(account, { now: T0 });
    await expect(verifyCaller(input(later.raw), deps)).rejects.toBe(unavailable);

    lookupHuman.mockRejectedValue(new Error("rpc exploded"));
    const rawLookup = await signedEnvelope(account, { now: T0 });
    await expect(verifyCaller(input(rawLookup.raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_UNAVAILABLE");
      expect(error.message).toBe("AgentBook lookup failed");
      expect(error.message).not.toContain("rpc exploded");
      return true;
    });
  });

  it("treats a malformed adapter argsHash as HORS_ARGS_MISMATCH", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 });
    await expect(verifyCaller(input(raw, { argsHash: "nope" }), deps)).rejects.toSatisfy(
      (error) => {
        expectCode(error, "HORS_ARGS_MISMATCH");
        return true;
      },
    );
  });

  it("wraps a store consumeOnce failure as HORS_UNAVAILABLE without echoing redis", async () => {
    const { raw } = await signedEnvelope(account, { now: T0 });
    const inner = new Error("redis down");
    deps = {
      ...deps,
      store: {
        get: async () => undefined,
        set: async () => undefined,
        incr: async () => 1,
        consumeOnce: async () => {
          throw inner;
        },
        delete: async () => undefined,
      },
    };
    await expect(verifyCaller(input(raw), deps)).rejects.toSatisfy((error) => {
      expectCode(error, "HORS_UNAVAILABLE");
      expect(error.message).toBe("store unavailable");
      expect(error.message).not.toContain("redis");
      expect((error.cause as Error).message).toBe("redis down");
      return true;
    });
  });
});
