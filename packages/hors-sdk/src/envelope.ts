import { AgentkitPayloadSchema } from "@worldcoin/agentkit-core";
import { ARGS_URN_PATTERN, functionIdFromUrn } from "./binding.js";
import { badEnvelope, HorsError } from "./errors.js";
import { type Address, type ChainId, isAddress, isChainId } from "./identity.js";

export const ENVELOPE_STATEMENT = "HORS v1 call";

export interface Envelope {
  readonly domain: string;
  readonly address: Address;
  readonly statement: "HORS v1 call";
  readonly uri: string;
  readonly version: "1";
  readonly chainId: ChainId;
  readonly type: "eip191" | "eip1271";
  readonly signatureScheme?: "eip191" | "eip1271" | "eip6492";
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime: string;
  readonly requestId: string;
  readonly resources: readonly [string, string, string];
  readonly signature: `0x${string}`;
}

const FQDN = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const NONCE = /^[A-Za-z0-9]{16,128}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_URN = /^urn:hors:v:[1-9][0-9]*$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2})+$/;
const URI_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const TYPES = new Set(["eip191", "eip1271"]);
const SCHEMES = new Set(["eip191", "eip1271", "eip6492"]);
const MAX_URI_LENGTH = 2048;
const MAX_FUNCTION_URN_LENGTH = 2048;
const EIP191_SIGNATURE_LENGTH = 132;
const MAX_EIP1271_SIGNATURE_LENGTH = 65_538;

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((octet) => IPV4_OCTET.test(octet));
}

function isDomain(value: string): boolean {
  return value === "localhost" || isIpv4(value) || FQDN.test(value);
}

function isTimestamp(value: string): boolean {
  if (!TIMESTAMP.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  // Round-trip rejects overflowed calendar dates such as 2026-13-45, which
  // Date.parse may still treat as finite.
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function schemaPaths(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string {
  const paths = [
    ...new Set(
      issues.map((issue) => issue.path.map(String).join(".")).filter((path) => path.length > 0),
    ),
  ];
  return paths.length === 0
    ? "envelope does not match the AgentKit payload schema"
    : `envelope does not match the AgentKit payload schema: ${paths.join(", ")}`;
}

function isUri(value: string): boolean {
  if (value.length > MAX_URI_LENGTH || !URI_CHARS.test(value) || BAD_PERCENT.test(value)) {
    return false;
  }
  if (!URL.canParse(value) || value.includes("?") || value.includes("#")) {
    return false;
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  return url.username === "" && url.password === "";
}

// Structural validation of the envelope; error messages never echo the offending value.
export function parseEnvelope(raw: unknown): Envelope {
  if (raw !== null && typeof raw === "object") {
    let resources: unknown;
    try {
      resources = (raw as { resources?: unknown }).resources;
    } catch {
      badEnvelope("envelope is not plain data");
    }
    if (!Array.isArray(resources) || resources.length !== 3) {
      badEnvelope("resources must contain exactly three URNs");
    }
  }

  let parsed: ReturnType<typeof AgentkitPayloadSchema.safeParse>;
  try {
    parsed = AgentkitPayloadSchema.safeParse(raw);
  } catch {
    badEnvelope("envelope is not plain data");
  }
  if (!parsed.success) {
    throw new HorsError("HORS_BAD_ENVELOPE", schemaPaths(parsed.error.issues));
  }
  const payload = parsed.data;
  function need(ok: boolean, message: string): asserts ok {
    if (!ok) badEnvelope(message);
  }

  need(payload.statement === ENVELOPE_STATEMENT, "statement must be exactly HORS v1 call");
  need(payload.version === "1", 'version must be "1"');
  need(payload.notBefore === undefined, "notBefore must be omitted");
  need(TYPES.has(payload.type), "type must be eip191 or eip1271");
  need(
    payload.signatureScheme === undefined || SCHEMES.has(payload.signatureScheme),
    "signatureScheme must be eip191, eip1271 or eip6492",
  );
  need(isChainId(payload.chainId), "chainId must be eip155:<positive integer>");
  need(isAddress(payload.address), "address must be a 20-byte 0x-prefixed hex string");
  need(
    isDomain(payload.domain) && payload.domain.length <= 253,
    "domain must be a hostname without a port or path",
  );
  need(isUri(payload.uri), "uri must be an http(s) URL without userinfo, query or fragment");
  need(NONCE.test(payload.nonce), "nonce must be 16 to 128 characters of [A-Za-z0-9]");
  need(isTimestamp(payload.issuedAt), "issuedAt must be YYYY-MM-DDTHH:mm:ss.sssZ");
  need(
    payload.expirationTime !== undefined && isTimestamp(payload.expirationTime),
    "expirationTime must be YYYY-MM-DDTHH:mm:ss.sssZ",
  );
  need(
    payload.requestId !== undefined && REQUEST_ID.test(payload.requestId),
    "requestId must be a lowercase hyphenated UUID v4",
  );
  const resources = payload.resources ?? [];
  const versionUrn = resources[0];
  const functionUrn = resources[1];
  const argsHashUrn = resources[2];
  need(
    typeof versionUrn === "string" && VERSION_URN.test(versionUrn),
    "resources[0] must be a HORS version URN",
  );
  need(
    typeof functionUrn === "string" && functionUrn.length <= MAX_FUNCTION_URN_LENGTH,
    "resources[1] must be a HORS function URN",
  );
  try {
    functionIdFromUrn(functionUrn);
  } catch {
    badEnvelope("resources[1] must be a HORS function URN");
  }
  need(
    typeof argsHashUrn === "string" && ARGS_URN_PATTERN.test(argsHashUrn),
    "resources[2] must be a HORS args SHA-256 URN",
  );
  need(SIGNATURE.test(payload.signature), "signature must be 0x-prefixed even-length hex");
  need(
    payload.type !== "eip191" || payload.signature.length === EIP191_SIGNATURE_LENGTH,
    "signature must be a 65-byte eip191 signature",
  );
  need(
    payload.type !== "eip1271" || payload.signature.length <= MAX_EIP1271_SIGNATURE_LENGTH,
    "signature must be at most 32 KiB",
  );

  const envelope: Envelope = {
    domain: payload.domain,
    address: payload.address,
    statement: ENVELOPE_STATEMENT,
    uri: payload.uri,
    version: "1",
    chainId: payload.chainId,
    type: payload.type as "eip191" | "eip1271",
    nonce: payload.nonce,
    issuedAt: payload.issuedAt,
    expirationTime: payload.expirationTime,
    requestId: payload.requestId,
    resources: [versionUrn, functionUrn, argsHashUrn],
    signature: payload.signature as `0x${string}`,
  };
  if (payload.signatureScheme !== undefined) {
    return {
      ...envelope,
      signatureScheme: payload.signatureScheme as "eip191" | "eip1271" | "eip6492",
    };
  }
  return envelope;
}
