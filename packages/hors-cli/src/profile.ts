import { createSigner } from "hors-sdk/client";
import {
  type GateConfig,
  loadConfig,
  PROFILE_NAME,
  type ProfileRecord,
  profileHome,
  readKeyFile,
  readProfile,
} from "hors-sdk/node";
import { privateKeyToAccount } from "viem/accounts";
import { type Flags, type Io, UsageError } from "./io.js";
import type { Outcome } from "./output.js";
import { notConnected, thrownMessage } from "./util.js";

export function resolveHome(io: Io, homeFlag: string | undefined): string {
  return homeFlag !== undefined && homeFlag !== "" ? homeFlag : profileHome(io.env);
}

export function resolveProfile(io: Io, profileFlag: string | undefined): string {
  const profile =
    profileFlag !== undefined && profileFlag !== ""
      ? profileFlag
      : io.env.HORS_PROFILE !== undefined && io.env.HORS_PROFILE !== ""
        ? io.env.HORS_PROFILE
        : "default";
  if (!PROFILE_NAME.test(profile)) {
    throw new UsageError("invalid --profile");
  }
  return profile;
}

export async function hasKey(home: string, name: string): Promise<boolean> {
  try {
    await readKeyFile(home, name);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "PROFILE_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

export async function openProfile(
  flags: Flags,
  requirePin: true,
): Promise<{ record: ProfileRecord & { humanId: string } } | { outcome: Outcome }>;
export async function openProfile(
  flags: Flags,
  requirePin?: boolean,
): Promise<{ record: ProfileRecord } | { outcome: Outcome }>;
export async function openProfile(
  flags: Flags,
  requirePin?: boolean,
): Promise<{ record: ProfileRecord } | { outcome: Outcome }> {
  if (!(await hasKey(flags.home, flags.profile))) {
    return { outcome: notConnected(flags.profile, flags.homeFlag) };
  }
  const record = await readProfile(flags.home, flags.profile);
  if (record === undefined || (requirePin && record.humanId === undefined)) {
    return { outcome: notConnected(flags.profile, flags.homeFlag) };
  }
  return { record };
}

export async function loadCallerConfig(io: Io, flags: Flags) {
  try {
    return { ...(await loadConfig({ cwd: io.cwd, env: { ...io.env, HORS_HOME: flags.home } })) };
  } catch (error) {
    return { error };
  }
}

export async function optionalConfig(io: Io, flags: Flags): Promise<GateConfig | undefined> {
  const loaded = await loadCallerConfig(io, flags);
  if ("error" in loaded) {
    io.stderr(`warning: config invalid (${thrownMessage(loaded.error)})`);
    return undefined;
  }
  return loaded.config;
}

export function callerOptions(
  home: string,
  config: GateConfig | undefined,
  fetchImpl?: typeof globalThis.fetch,
) {
  return {
    services: config?.services,
    rpc:
      config === undefined ? undefined : { ens: config.rpc.ens, signatures: config.rpc.signatures },
    cache: { home },
    fetch: fetchImpl,
  };
}

export async function cliSigner(
  home: string,
  profile: string,
  config: GateConfig | undefined,
  fetchImpl?: typeof globalThis.fetch,
) {
  const key = await readKeyFile(home, profile);
  return createSigner({
    account: privateKeyToAccount(key),
    profile,
    ...callerOptions(home, config, fetchImpl),
  });
}
