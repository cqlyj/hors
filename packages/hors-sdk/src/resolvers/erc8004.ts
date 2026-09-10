import { createPublicClient, http } from "viem";
import * as chains from "viem/chains";
import { base64ToBytes } from "../base64.js";
import { echo, HorsError } from "../errors.js";
import { BodyLimitError, readStreamCapped } from "../limit.js";
import { isPlainObject } from "../plain.js";
import { httpUrlWithoutCredentials } from "../url.js";
import { ERC8004_IDENTITY_REGISTRY, type ResolveOptions } from "./types.js";

export const ERC8004_URI = /^erc8004:eip155:([1-9][0-9]*)\/(\d{1,78})$/;
const TOKEN_URI_ABI = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
const MAX_REGISTRATION_BYTES = 1_048_576;
const IPFS_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;

const DEFAULT_RPC = new Map<number, string>();
for (const entry of Object.values(chains)) {
  if (entry && typeof entry === "object" && "id" in entry && typeof entry.id === "number") {
    const url = "rpcUrls" in entry ? entry.rpcUrls.default.http[0] : undefined;
    if (url !== undefined) {
      DEFAULT_RPC.set(entry.id, url);
    }
  }
}

export const erc8004Runtime = {
  async tokenURI(agentId: bigint, rpc: string): Promise<string> {
    const client = createPublicClient({ transport: http(rpc) });
    return client.readContract({
      address: ERC8004_IDENTITY_REGISTRY,
      abi: TOKEN_URI_ABI,
      functionName: "tokenURI",
      args: [agentId],
    });
  },
};

function failed(message: string, cause?: unknown): never {
  throw new HorsError(
    "RESOLVER_FAILED",
    message,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function rpcFor(caip2: string, chainId: number, options?: ResolveOptions): string {
  const configured = options?.rpc?.signatures?.[caip2];
  if (configured !== undefined) {
    return configured;
  }
  const fallback = DEFAULT_RPC.get(chainId);
  if (fallback === undefined) {
    failed(`no RPC for ${caip2}`);
  }
  return fallback;
}

function ipfsUrl(uri: string, gateway: string): string {
  const rest = uri.slice("ipfs://".length);
  if (rest.includes("?") || rest.includes("#") || !IPFS_PATH.test(rest)) {
    failed("malformed ipfs URI");
  }
  return gateway.endsWith("/") ? gateway + rest : `${gateway}/${rest}`;
}

function decodeDataUri(uri: string): string {
  if (!uri.startsWith("data:application/json")) {
    failed("registration file URI scheme is not supported");
  }
  const comma = uri.indexOf(",");
  if (comma === -1) {
    failed("registration file data URI is malformed");
  }
  const meta = uri.slice("data:".length, comma);
  const data = uri.slice(comma + 1);
  let text: string;
  try {
    if (meta === "application/json;base64" || meta.endsWith(";base64")) {
      text = new TextDecoder().decode(base64ToBytes(data));
    } else if (meta === "application/json" || meta.startsWith("application/json;")) {
      text = decodeURIComponent(data);
    } else {
      failed("registration file data URI is malformed");
    }
  } catch (error) {
    failed("registration file data URI is malformed", error);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_REGISTRATION_BYTES) {
    failed("registration file exceeds 1 MiB");
  }
  return text;
}

async function readRegistration(uri: string, options?: ResolveOptions): Promise<string> {
  if (uri.startsWith("data:")) {
    return decodeDataUri(uri);
  }
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const gateway = options?.ipfsGateway ?? "https://ipfs.io/ipfs/";
  const url = uri.startsWith("ipfs://")
    ? ipfsUrl(uri, gateway)
    : uri.startsWith("https:")
      ? uri
      : failed("registration file URI scheme is not supported");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      failed("registration file fetch failed", error);
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > MAX_REGISTRATION_BYTES) {
      failed("registration file exceeds 1 MiB");
    }
    try {
      return await Promise.race([readBody(response), whenAborted(controller.signal)]);
    } catch (error) {
      if (error instanceof BodyLimitError) {
        failed("registration file exceeds 1 MiB");
      }
      failed("registration file fetch failed", error);
    }
  } finally {
    clearTimeout(timer);
  }
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

async function readBody(response: Response): Promise<string> {
  if (response.body !== null && typeof response.body.getReader === "function") {
    const bytes = await readStreamCapped(response.body, MAX_REGISTRATION_BYTES);
    return new TextDecoder().decode(bytes);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REGISTRATION_BYTES) {
    throw new BodyLimitError(MAX_REGISTRATION_BYTES);
  }
  return text;
}

function mcpEndpoint(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    failed("registration file is not valid JSON", error);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.services)) {
    failed("registration file must be an object with a services array");
  }
  for (const entry of parsed.services) {
    if (
      !isPlainObject(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.endpoint !== "string"
    ) {
      continue;
    }
    if (entry.name.toLowerCase() !== "mcp") {
      continue;
    }
    const url = httpUrlWithoutCredentials(entry.endpoint);
    if (url !== undefined) {
      return entry.endpoint;
    }
  }
  failed("no MCP service in the registration file");
}

export async function erc8004(uri: string, options?: ResolveOptions): Promise<string> {
  const match = ERC8004_URI.exec(uri);
  if (match === null) {
    failed(`malformed erc8004 URI: ${echo(uri)}`);
  }
  const chainId = Number(match[1]);
  const caip2 = `eip155:${match[1]}`;
  const agentId = BigInt(match[2] ?? "0");
  const rpc = rpcFor(caip2, chainId, options);
  let tokenUri: unknown;
  try {
    tokenUri = await erc8004Runtime.tokenURI(agentId, rpc);
  } catch (error) {
    if (error instanceof HorsError) {
      throw error;
    }
    failed("tokenURI read failed", error);
  }
  if (typeof tokenUri !== "string") {
    failed("tokenURI is not a string");
  }
  return mcpEndpoint(await readRegistration(tokenUri, options));
}
