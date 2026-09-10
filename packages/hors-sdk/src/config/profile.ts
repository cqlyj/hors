import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HorsError } from "../errors.js";
import {
  type Address,
  type HumanId,
  isAddress,
  normalizeAddress,
  parseHumanId,
} from "../identity.js";
import { hasControlCharacter, isPlainObject } from "../plain.js";
import type { Env } from "./env.js";
import { isErrno } from "./errno.js";
import { PROFILE_NAME } from "./profile-name.js";

export { PROFILE_NAME };

const PROFILE_MAX_BYTES = 1_048_576;
const LABEL_MAX = 200;

export interface ProfileRecord {
  readonly address: Address;
  readonly humanId?: HumanId;
  readonly registeredAt?: string;
  readonly createdAt?: string;
  readonly label?: string;
}

export function profileHome(env?: Env): string {
  const resolved = env ?? { ...process.env };
  const home = resolved.HORS_HOME;
  return home !== undefined && home !== "" ? home : path.join(os.homedir(), ".hors");
}

export function profilePath(home: string, name: string): string {
  return path.join(home, name, "profile.json");
}

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) {
    throw new HorsError("CONFIG_INVALID", "profile name is invalid");
  }
}

export function assertLabel(label: string): void {
  if (typeof label !== "string" || label.length > LABEL_MAX || hasControlCharacter(label)) {
    throw new HorsError(
      "CONFIG_INVALID",
      "profile label must be a string of at most 200 characters without control characters",
    );
  }
}

function optionalString(value: unknown, field: string, file: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HorsError("CONFIG_INVALID", `profile.json has an invalid ${field}: ${file}`);
  }
  return value;
}

export async function readProfile(home: string, name: string): Promise<ProfileRecord | undefined> {
  assertProfileName(name);
  const file = profilePath(home, name);
  let info: Stats;
  try {
    info = await stat(file);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return undefined;
    }
    throw new HorsError("CONFIG_INVALID", `profile.json is not readable: ${file}`, undefined, {
      cause: error,
    });
  }
  if (!info.isFile()) {
    throw new HorsError("CONFIG_INVALID", `profile.json is not a regular file: ${file}`);
  }
  if (info.size > PROFILE_MAX_BYTES) {
    throw new HorsError("CONFIG_INVALID", `profile.json exceeds 1 MiB: ${file}`);
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new HorsError("CONFIG_INVALID", `profile.json is not readable: ${file}`, undefined, {
      cause: error,
    });
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HorsError("CONFIG_INVALID", `profile.json is not valid JSON: ${file}`);
  }
  if (!isPlainObject(parsed)) {
    throw new HorsError("CONFIG_INVALID", `profile.json must be an object: ${file}`);
  }
  if (!isAddress(parsed.address)) {
    throw new HorsError("CONFIG_INVALID", `profile.json has an invalid address: ${file}`);
  }
  const address = normalizeAddress(parsed.address);
  const createdAt = optionalString(parsed.createdAt, "createdAt", file);
  const registeredAt = optionalString(parsed.registeredAt, "registeredAt", file);
  let label: string | undefined;
  if (parsed.label !== undefined) {
    if (typeof parsed.label !== "string") {
      throw new HorsError("CONFIG_INVALID", `profile.json has an invalid label: ${file}`);
    }
    assertLabel(parsed.label);
    label = parsed.label;
  }
  const record: ProfileRecord = {
    address,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(registeredAt === undefined ? {} : { registeredAt }),
    ...(label === undefined ? {} : { label }),
  };
  if (!Object.hasOwn(parsed, "humanId") || parsed.humanId === undefined) {
    return record;
  }
  const humanId = parseHumanId(parsed.humanId);
  if (humanId === undefined) {
    throw new HorsError("CONFIG_INVALID", `profile.json has an invalid humanId: ${file}`);
  }
  return { ...record, humanId };
}
