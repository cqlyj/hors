import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isPrivateKey } from "../config/private-key.js";
import { type ProfileRecord, profilePath } from "../config/profile.js";
import { HorsError, thrownMessage } from "../errors.js";
import { type Address, type HumanId, normalizeAddress } from "../identity.js";
import { MockAgentBook } from "../world/mock.js";
import type { Logger } from "./logger.js";

type ReadProfile = (home: string, name: string) => Promise<ProfileRecord | undefined>;

export const OWNER_RECHECK_MS = 10_000;

export interface OwnerSource {
  readonly configured: "auto" | HumanId;
  readonly mock: boolean;
  readonly address: Address | null;
  readonly profile: { readonly home: string; readonly name: string };
  readonly initial: ProfileRecord | undefined;
}

export interface OwnerResolver {
  current(): HumanId | null;
  resolve(now: number): Promise<HumanId | null>;
}

const UNRESOLVED =
  "HORS owner unresolved: remote same-human calls are denied until the profile is connected";

export function warnOwnerUnresolved(
  log: Logger,
  profile: { readonly home: string; readonly name: string },
): void {
  log("error", UNRESOLVED, {
    fix: `hors connect --profile ${profile.name}`,
    alternative: "set HORS_OWNER to the value of hors whoami",
    profile: profilePath(profile.home, profile.name),
  });
}

function resolved(owner: HumanId): OwnerResolver {
  return {
    current: () => owner,
    resolve: async () => owner,
  };
}

export function createOwnerResolver(
  source: OwnerSource,
  deps: { readonly readProfile: ReadProfile; readonly log: Logger },
): OwnerResolver {
  const file = profilePath(source.profile.home, source.profile.name);
  if (source.configured !== "auto") {
    return resolved(source.configured);
  }
  if (source.mock && source.address !== null) {
    return resolved(MockAgentBook.humanIdOf(source.address));
  }
  if (!source.mock && source.initial?.humanId !== undefined) {
    return resolved(source.initial.humanId);
  }

  warnOwnerUnresolved(deps.log, source.profile);

  let owner: HumanId | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  return {
    current: () => owner,
    async resolve(now: number) {
      if (owner !== null) {
        return owner;
      }
      if (now - lastAttempt < OWNER_RECHECK_MS) {
        return null;
      }
      // WHY: lastAttempt is set before the read so a second concurrent caller
      // sees the window closed and returns null; no in-flight promise sharing.
      // Non-finite now must not close the window forever (resolve(Infinity)).
      if (Number.isFinite(now)) {
        lastAttempt = now;
      }
      try {
        const profile = await deps.readProfile(source.profile.home, source.profile.name);
        if (profile?.humanId !== undefined) {
          owner = profile.humanId;
          deps.log("info", "HORS owner resolved", { profile: file });
          return owner;
        }
      } catch (error) {
        deps.log("error", "profile.json is invalid", {
          path: file,
          message: thrownMessage(error),
        });
      }
      return null;
    },
  };
}

export function gateAddress(input: {
  readonly privateKey: string | undefined;
  readonly profile: ProfileRecord | undefined;
  readonly mock: boolean;
  readonly log: Logger;
}): Address | null {
  const key = input.privateKey;
  if (key !== undefined) {
    if (!isPrivateKey(key)) {
      throw new HorsError(
        "CONFIG_INVALID",
        "HORS_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
      );
    }
    try {
      return normalizeAddress(privateKeyToAccount(key).address);
    } catch {
      throw new HorsError(
        "CONFIG_INVALID",
        "HORS_PRIVATE_KEY must be a valid secp256k1 private key",
      );
    }
  }
  if (input.profile !== undefined) {
    return input.profile.address;
  }
  if (input.mock) {
    const address = normalizeAddress(privateKeyToAccount(generatePrivateKey()).address);
    input.log("error", "HORS mock mode: no profile found, using an ephemeral address", { address });
    return address;
  }
  return null;
}
