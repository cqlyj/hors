import { ARGS_HASH, argsUrn, functionUrn, HORS_VERSION_URN } from "../binding.js";
import { ENVELOPE_STATEMENT, type Envelope } from "../envelope.js";
import { HorsError } from "../errors.js";
import { type ChainId, normalizeAddress } from "../identity.js";
import { httpUrlWithoutCredentials } from "../url.js";
import { siweMessage } from "../verify/signature.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomNonce(): string {
  // Modulo bias is irrelevant for a 22-character nonce (not a secret key).
  const bytes = new Uint8Array(22);
  crypto.getRandomValues(bytes);
  let nonce = "";
  for (const byte of bytes) {
    nonce += ALPHABET[byte % 62];
  }
  return nonce;
}

function parseCallUrl(url: string): URL {
  const parsed = httpUrlWithoutCredentials(url);
  if (parsed === undefined) {
    throw new HorsError("CONFIG_INVALID", "url must be an http(s) URL without credentials");
  }
  if (parsed.hostname.includes(":")) {
    throw new HorsError("CONFIG_INVALID", "url host must not be an IPv6 address");
  }
  return parsed;
}

export async function buildEnvelope(input: {
  account: { address: string; signMessage: (args: { message: string }) => Promise<`0x${string}`> };
  url: string;
  fn: string;
  argsHash: string;
  chainId: ChainId;
  expirySeconds: number;
  now?: number;
}): Promise<Envelope> {
  if (!ARGS_HASH.test(input.argsHash)) {
    throw new HorsError("CONFIG_INVALID", "argsHash must be 64 lowercase hex characters");
  }
  const parsed = parseCallUrl(input.url);
  const now = input.now ?? Date.now();
  const address = normalizeAddress(input.account.address);
  const unsigned: Envelope = {
    domain: parsed.hostname,
    address,
    statement: ENVELOPE_STATEMENT,
    uri: parsed.origin + parsed.pathname,
    version: "1",
    chainId: input.chainId,
    type: "eip191",
    nonce: randomNonce(),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + input.expirySeconds * 1000).toISOString(),
    requestId: crypto.randomUUID(),
    resources: [HORS_VERSION_URN, functionUrn(input.fn), argsUrn(input.argsHash)],
    signature: `0x${"00".repeat(65)}`,
  };
  const message = siweMessage(unsigned);
  const signature = await input.account.signMessage({ message });
  return { ...unsigned, signature };
}
