import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnvelope } from "../src/envelope.js";
import { HorsError } from "../src/errors.js";
import {
  createSignatureVerifiers,
  type SignatureVerifier,
  siweMessage,
  verifySignature,
} from "../src/verify/signature.js";
import { signedEnvelope, testAccount } from "./helpers/sign.js";

const T0 = Date.parse("2026-09-08T02:15:30.123Z");

function flipSignature(signature: string): `0x${string}` {
  const hex = signature.slice(2);
  const next = hex.startsWith("0") ? "1" : "0";
  return `0x${next}${hex.slice(1)}` as `0x${string}`;
}

describe("signature verification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds the signed SIWE text and accepts a matching eip191 signature", async () => {
    const account = testAccount();
    const { raw, message } = await signedEnvelope(account, { now: T0 });
    const envelope = parseEnvelope(raw);
    expect(siweMessage(envelope)).toBe(message);
    await expect(verifySignature(envelope, message, undefined)).resolves.toBeUndefined();
  });

  it("rejects a flipped signature, a foreign address, and a tampered nonce", async () => {
    const account = testAccount();
    const other = testAccount();
    const { raw, message } = await signedEnvelope(account, { now: T0 });
    const envelope = parseEnvelope(raw);

    await expect(
      verifySignature(
        parseEnvelope({ ...raw, signature: flipSignature(String(raw.signature)) }),
        message,
        undefined,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "HORS_BAD_SIGNATURE" }));

    const swapped = await signedEnvelope(account, {
      now: T0,
      tamper: { address: other.address },
    });
    await expect(
      verifySignature(parseEnvelope(swapped.raw), swapped.message, undefined),
    ).rejects.toEqual(expect.objectContaining({ code: "HORS_BAD_SIGNATURE" }));

    const nonceTamper = await signedEnvelope(account, {
      now: T0,
      tamper: { nonce: "AAAAAAAAAAAAAAAAAAAAAA" },
    });
    await expect(
      verifySignature(
        parseEnvelope(nonceTamper.raw),
        siweMessage(parseEnvelope(nonceTamper.raw)),
        undefined,
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "HORS_BAD_SIGNATURE" }));

    const verifier = { verifyMessage: vi.fn() } satisfies SignatureVerifier;
    await verifySignature(envelope, message, verifier);
    expect(verifier.verifyMessage).not.toHaveBeenCalled();
  });

  it("verifies eip1271 through the supplied verifier and fails closed without one", async () => {
    const account = testAccount();
    const { raw, message } = await signedEnvelope(account, {
      now: T0,
      fields: { type: "eip1271" },
    });
    const envelope = parseEnvelope(raw);

    await expect(verifySignature(envelope, message, undefined)).rejects.toEqual(
      expect.objectContaining({
        code: "HORS_UNAVAILABLE",
        message: "no RPC configured for the envelope's chain",
      }),
    );

    const denied: SignatureVerifier = { verifyMessage: vi.fn(async () => false) };
    await expect(verifySignature(envelope, message, denied)).rejects.toEqual(
      expect.objectContaining({ code: "HORS_BAD_SIGNATURE" }),
    );

    const ok: SignatureVerifier = { verifyMessage: vi.fn(async () => true) };
    await verifySignature(envelope, message, ok);
    expect(ok.verifyMessage).toHaveBeenCalledOnce();
    expect(ok.verifyMessage).toHaveBeenCalledWith({
      address: envelope.address,
      message,
      signature: envelope.signature,
    });

    const inner = new Error("rpc down");
    const failing: SignatureVerifier = {
      verifyMessage: vi.fn(async () => {
        throw inner;
      }),
    };
    try {
      await verifySignature(envelope, message, failing);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_UNAVAILABLE");
      expect((error as HorsError).cause).toBe(inner);
    }
  });

  it("resolves only configured RPCs plus World Chain by default and memoises them", () => {
    const empty = createSignatureVerifiers({});
    expect(empty("eip155:480")).toBeDefined();
    expect(empty("eip155:1")).toBeUndefined();
    expect(empty("eip155:9876543210")).toBeUndefined();
    expect(empty("solana:x")).toBeUndefined();
    expect(empty("eip155:480")).toBe(empty("eip155:480"));

    const custom = createSignatureVerifiers({ "eip155:1": "http://127.0.0.1:1" });
    expect(custom("eip155:1")).toBeDefined();
    expect(custom("eip155:1")).toBe(custom("eip155:1"));

    const proto = createSignatureVerifiers({ constructor: "http://127.0.0.1:1" });
    expect(proto("constructor")).toBeUndefined();
  });
});
