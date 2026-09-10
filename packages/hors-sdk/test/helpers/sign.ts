import { formatSIWEMessage } from "@worldcoin/agentkit-core";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { argsUrn, functionUrn, HORS_VERSION_URN } from "../../src/binding.js";
import { ENVELOPE_STATEMENT } from "../../src/envelope.js";

export const DEFAULT_ARGS_HASH = "f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab";
export const DEFAULT_FN = "approveTravelExpense";

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function testAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export function randomNonce(length = 22): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let nonce = "";
  for (const byte of bytes) {
    nonce += ALPHANUM[byte % ALPHANUM.length];
  }
  return nonce;
}

export async function signedEnvelope(
  account: PrivateKeyAccount,
  options?: {
    fn?: string;
    argsHash?: string;
    fields?: Record<string, unknown>;
    tamper?: Record<string, unknown>;
    now?: number;
  },
): Promise<{ raw: Record<string, unknown>; message: string }> {
  const now = options?.now ?? Date.now();
  const fn = options?.fn ?? DEFAULT_FN;
  const argsHash = options?.argsHash ?? DEFAULT_ARGS_HASH;
  const payload: Record<string, unknown> = {
    domain: "work.example.com",
    address: account.address,
    statement: ENVELOPE_STATEMENT,
    uri: "https://work.example.com/mcp",
    version: "1",
    chainId: "eip155:480",
    type: "eip191",
    nonce: randomNonce(),
    issuedAt: new Date(now).toISOString(),
    expirationTime: new Date(now + 120_000).toISOString(),
    requestId: crypto.randomUUID(),
    resources: [HORS_VERSION_URN, functionUrn(fn), argsUrn(argsHash)],
    ...options?.fields,
  };
  const message = formatSIWEMessage(
    {
      domain: String(payload.domain),
      uri: String(payload.uri),
      statement: String(payload.statement),
      version: String(payload.version),
      nonce: String(payload.nonce),
      issuedAt: String(payload.issuedAt),
      expirationTime: String(payload.expirationTime),
      requestId: String(payload.requestId),
      resources: [...(payload.resources as string[])],
      chainId: String(payload.chainId),
      type: payload.type as "eip191" | "eip1271",
      ...(payload.signatureScheme === undefined
        ? {}
        : { signatureScheme: payload.signatureScheme as "eip191" | "eip1271" | "eip6492" }),
    },
    String(payload.address),
  );
  const signature = await account.signMessage({ message });
  return {
    raw: JSON.parse(JSON.stringify({ ...payload, signature, ...options?.tamper })),
    message,
  };
}
