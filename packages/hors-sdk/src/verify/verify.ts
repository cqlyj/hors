import { functionIdFromUrn, HORS_VERSION_URN } from "../binding.js";
import { parseEnvelope } from "../envelope.js";
import { HorsError } from "../errors.js";
import { type Address, type HumanId, normalizeAddress } from "../identity.js";
import type { Store } from "../store.js";
import type { AgentBook } from "../world/agentbook.js";
import { type ExpectedUrl, matchExpectedUrl } from "./expected-url.js";
import { type SignatureVerifier, siweMessage, verifySignature } from "./signature.js";

export const DEFAULT_MAX_AGE_MS = 300_000;
export const DEFAULT_CLOCK_SKEW_MS = 30_000;

export interface VerifyInput {
  readonly auth: unknown;
  readonly fn: string;
  readonly argsHash: string;
  readonly expected: readonly ExpectedUrl[];
  readonly publicOrigin: boolean;
  /**
   * Date.now() read once at the start of the request by the adapter; the replay
   * store and the AgentBook cache use the same wall clock, so any other value
   * reopens the boundary replay window
   */
  readonly now: number;
}

export interface VerifyDeps {
  readonly store: Store;
  readonly agentBook: AgentBook;
  readonly deny: ReadonlySet<Address>;
  readonly signatureVerifier: (chainId: string) => SignatureVerifier | undefined;
  readonly maxAgeMs: number;
  readonly clockSkewMs: number;
}

export type Caller =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "signed";
      readonly address: Address;
      readonly humanId: HumanId | null;
      readonly chainId: string;
      readonly callId: string;
    };

async function lookupHuman(agentBook: AgentBook, address: Address): Promise<HumanId | null> {
  try {
    return await agentBook.lookupHuman(address);
  } catch (error) {
    if (error instanceof HorsError) {
      throw error;
    }
    throw new HorsError("HORS_UNAVAILABLE", "AgentBook lookup failed", undefined, { cause: error });
  }
}

async function consumeOnce(store: Store, key: string, ttlMs: number): Promise<boolean> {
  try {
    return await store.consumeOnce(key, ttlMs);
  } catch (error) {
    if (error instanceof HorsError) {
      throw error;
    }
    throw new HorsError("HORS_UNAVAILABLE", "store unavailable", undefined, { cause: error });
  }
}

export async function verifyCaller(input: VerifyInput, deps: VerifyDeps): Promise<Caller> {
  // 1. Unsigned: allowed only for public functions.
  if (input.auth === undefined) {
    if (input.publicOrigin) {
      return { kind: "anonymous" };
    }
    throw new HorsError("HORS_UNSIGNED", "envelope required");
  }

  // 2. Parse and validate the envelope.
  const envelope = parseEnvelope(input.auth);

  // 3. Domain and path must match the expected URL.
  matchExpectedUrl(envelope, input.expected);

  // 4. Freshness.
  // The age check is strict on purpose: an envelope issued clockSkewMs in the
  // future stays acceptable until t0 + maxAgeMs + clockSkewMs exclusive, which
  // is exactly when its step 9 store entry (TTL maxAgeMs + clockSkewMs, expiry
  // inclusive) disappears; an inclusive age check would open a one-millisecond
  // replay window there.
  const issued = Date.parse(envelope.issuedAt);
  const expires = Date.parse(envelope.expirationTime);
  if (input.now - issued >= deps.maxAgeMs) {
    throw new HorsError("HORS_EXPIRED", "issuedAt is older than maxAge");
  }
  if (issued - input.now > deps.clockSkewMs) {
    throw new HorsError("HORS_EXPIRED", "issuedAt is in the future");
  }
  if (expires <= input.now) {
    throw new HorsError("HORS_EXPIRED", "expirationTime has passed");
  }

  // 5. Protocol version.
  if (envelope.resources[0] !== HORS_VERSION_URN) {
    throw new HorsError("HORS_VERSION", "unsupported HORS version");
  }

  // 6. Bound function.
  if (functionIdFromUrn(envelope.resources[1]) !== input.fn) {
    throw new HorsError("HORS_FUNCTION_MISMATCH", "envelope is bound to a different function");
  }

  // 7. Bound arguments.
  if (envelope.resources[2] !== `urn:hors:args:sha256:${input.argsHash}`) {
    throw new HorsError("HORS_ARGS_MISMATCH", "arguments do not match the envelope");
  }

  // 8. Signature (EOA or EIP-1271).
  const message = siweMessage(envelope);
  await verifySignature(
    envelope,
    message,
    envelope.type === "eip1271" ? deps.signatureVerifier(envelope.chainId) : undefined,
  );

  // 9. Replay: nonce and callId are single-use for maxAge + skew.
  const ttl = deps.maxAgeMs + deps.clockSkewMs;
  if (!(await consumeOnce(deps.store, `nonce:${envelope.nonce}`, ttl))) {
    throw new HorsError("HORS_REPLAY", "nonce already used");
  }
  if (!(await consumeOnce(deps.store, `call:${envelope.requestId}`, ttl))) {
    throw new HorsError("HORS_REPLAY", "callId already used");
  }

  // 10. Deny list.
  const address = normalizeAddress(envelope.address);
  if (deps.deny.has(address)) {
    throw new HorsError("HORS_DENIED_WALLET", "wallet is denied");
  }

  // 11. Identity: the wallet must be registered unless the function is public.
  const humanId = await lookupHuman(deps.agentBook, address);
  if (humanId === null && !input.publicOrigin) {
    throw new HorsError("HORS_NOT_HUMAN", "wallet is not registered in AgentBook");
  }

  return {
    kind: "signed",
    address,
    humanId,
    chainId: envelope.chainId,
    callId: envelope.requestId,
  };
}
