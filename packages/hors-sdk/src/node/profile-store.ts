import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isErrno } from "../config/errno.js";
import { assertLabel, assertProfileName, type ProfileRecord } from "../config/profile.js";
import { HorsError } from "../errors.js";
import { normalizeAddress, normalizeHumanId } from "../identity.js";

export async function writeProfile(
  home: string,
  name: string,
  record: ProfileRecord,
): Promise<void> {
  assertProfileName(name);
  if (record.label !== undefined) {
    assertLabel(record.label);
  }
  const body: Record<string, unknown> = {
    address: normalizeAddress(record.address),
  };
  if (record.humanId !== undefined) {
    body.humanId = normalizeHumanId(record.humanId);
  }
  if (record.registeredAt !== undefined) {
    body.registeredAt = record.registeredAt;
  }
  if (record.createdAt !== undefined) {
    body.createdAt = record.createdAt;
  }
  if (record.label !== undefined) {
    body.label = record.label;
  }
  const dir = join(home, name);
  const file = join(dir, "profile.json");
  const tmp = join(dir, "profile.json.tmp");
  await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function createProfile(
  home: string,
  name: string,
  init?: { label?: string },
): Promise<ProfileRecord> {
  assertProfileName(name);
  if (init?.label !== undefined) {
    assertLabel(init.label);
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const dir = join(home, name);
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
  }
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  try {
    await writeFile(join(dir, "key"), `${key}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new HorsError("CONFIG_INVALID", `profile ${name} already exists`);
    }
    throw error;
  }
  const record: ProfileRecord = {
    address: normalizeAddress(account.address),
    createdAt: new Date().toISOString(),
    ...(init?.label === undefined ? {} : { label: init.label }),
  };
  await writeProfile(home, name, record);
  return record;
}

export async function deleteProfile(home: string, name: string): Promise<void> {
  assertProfileName(name);
  await rm(join(home, name), { recursive: true, force: true });
}
