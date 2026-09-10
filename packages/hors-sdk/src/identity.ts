import { HorsError } from "./errors.js";

export type HumanId = `0x${string}`; // normalised, 32 bytes
export type Address = `0x${string}`; // EVM address

const HUMAN_ID = /^0x[0-9a-f]{64}$/;
const HUMAN_ID_INPUT = /^0x[0-9a-fA-F]{1,64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_HUMAN_ID = `0x${"0".repeat(64)}`;
const UINT256_MAX = 2n ** 256n;

function invalidHumanId(): never {
  throw new HorsError("CONFIG_INVALID", "humanId must be a non-zero 0x-prefixed uint256");
}

export function parseHumanId(value: unknown): HumanId | undefined {
  let hex: string;
  if (typeof value === "bigint") {
    if (value <= 0n || value >= UINT256_MAX) {
      return undefined;
    }
    hex = value.toString(16);
  } else if (typeof value === "string") {
    if (!HUMAN_ID_INPUT.test(value)) {
      return undefined;
    }
    hex = value.slice(2);
  } else {
    return undefined;
  }
  const normalised = `0x${hex.toLowerCase().padStart(64, "0")}` as HumanId;
  if (normalised === ZERO_HUMAN_ID) {
    return undefined;
  }
  return normalised;
}

export function normalizeHumanId(value: string | bigint): HumanId {
  return parseHumanId(value) ?? invalidHumanId();
}

export function isHumanId(value: unknown): value is HumanId {
  return typeof value === "string" && HUMAN_ID.test(value) && value !== ZERO_HUMAN_ID;
}

export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS.test(value);
}

export function normalizeAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new HorsError("CONFIG_INVALID", "address must be a 20-byte 0x-prefixed hex string");
  }
  return value.toLowerCase() as Address;
}

export type ChainId = `eip155:${string}`;

const CHAIN_ID = /^eip155:[1-9][0-9]*$/;

// CAIP-2 eip155 id: positive decimal safe integer without leading zeros (the envelope chainId).
export function isChainId(value: unknown): value is ChainId {
  if (typeof value !== "string" || !CHAIN_ID.test(value)) {
    return false;
  }
  return Number.isSafeInteger(Number(value.slice(7)));
}
