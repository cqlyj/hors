import { formatSIWEMessage } from "@worldcoin/agentkit-core";
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { worldchain } from "viem/chains";
import type { Envelope } from "../envelope.js";
import { HorsError } from "../errors.js";
import type { Address } from "../identity.js";
import { RPC_TRANSPORT_OPTIONS } from "../world/agentbook.js";

export interface SignatureVerifier {
  verifyMessage(args: {
    address: Address;
    message: string;
    signature: `0x${string}`;
  }): Promise<boolean>;
}

function siweInfo(envelope: Envelope) {
  return {
    domain: envelope.domain,
    uri: envelope.uri,
    statement: envelope.statement,
    version: envelope.version,
    nonce: envelope.nonce,
    issuedAt: envelope.issuedAt,
    expirationTime: envelope.expirationTime,
    requestId: envelope.requestId,
    resources: [...envelope.resources],
    chainId: envelope.chainId,
    type: envelope.type,
    ...(envelope.signatureScheme === undefined
      ? {}
      : { signatureScheme: envelope.signatureScheme }),
  };
}

export function siweMessage(envelope: Envelope): string {
  try {
    return formatSIWEMessage(siweInfo(envelope), envelope.address);
  } catch {
    throw new HorsError("HORS_BAD_SIGNATURE", "envelope cannot be rendered as a SIWE message");
  }
}

export async function verifySignature(
  envelope: Envelope,
  message: string,
  verifier: SignatureVerifier | undefined,
): Promise<void> {
  if (envelope.type === "eip191") {
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message, signature: envelope.signature });
    } catch {
      throw new HorsError("HORS_BAD_SIGNATURE", "signature does not match address");
    }
    if (recovered.toLowerCase() !== envelope.address.toLowerCase()) {
      throw new HorsError("HORS_BAD_SIGNATURE", "signature does not match address");
    }
    return;
  }

  if (verifier === undefined) {
    throw new HorsError("HORS_UNAVAILABLE", "no RPC configured for the envelope's chain");
  }
  try {
    const ok = await verifier.verifyMessage({
      address: envelope.address,
      message,
      signature: envelope.signature,
    });
    if (!ok) {
      throw new HorsError("HORS_BAD_SIGNATURE", "signature does not match address");
    }
  } catch (error) {
    if (error instanceof HorsError) {
      throw error;
    }
    throw new HorsError("HORS_UNAVAILABLE", "signature verification RPC failed", undefined, {
      cause: error,
    });
  }
}

function resolveSignatureRpc(
  chainId: string,
  rpcUrls: Readonly<Record<string, string>>,
  worldchainRpcUrl: string | undefined,
): string | undefined {
  // WHY: fail closed on egress — only eip155 chain ids, and only own
  // properties of rpc.signatures (not Object.prototype.constructor).
  if (chainId.startsWith("eip155:") && Object.hasOwn(rpcUrls, chainId)) {
    return rpcUrls[chainId];
  }
  if (chainId === "eip155:480") {
    return worldchainRpcUrl ?? worldchain.rpcUrls.default.http[0];
  }
  return undefined;
}

export function createSignatureVerifiers(
  rpcUrls: Readonly<Record<string, string>>,
  options?: { readonly worldchainRpcUrl?: string },
): (chainId: string) => SignatureVerifier | undefined {
  const memo = new Map<string, SignatureVerifier>();
  return (chainId: string): SignatureVerifier | undefined => {
    const cached = memo.get(chainId);
    if (cached !== undefined) {
      return cached;
    }
    // WHY: fail closed on egress — only deployer-configured RPCs, plus World
    // Chain (World App wallets are smart accounts there).
    const url = resolveSignatureRpc(chainId, rpcUrls, options?.worldchainRpcUrl);
    if (url === undefined) {
      return undefined;
    }
    const client = createPublicClient({
      ...(chainId === "eip155:480" ? { chain: worldchain } : {}),
      transport: http(url, RPC_TRANSPORT_OPTIONS),
    });
    const verifier: SignatureVerifier = {
      verifyMessage: (args) => client.verifyMessage(args),
    };
    memo.set(chainId, verifier);
    return verifier;
  };
}
