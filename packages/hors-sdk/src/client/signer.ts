import { privateKeyToAccount } from "viem/accounts";
import { type Env, nonEmpty } from "../config/env.js";
import { isPrivateKey } from "../config/private-key.js";
import { PROFILE_NAME } from "../config/profile-name.js";
import { HorsError } from "../errors.js";
import type { HumanId } from "../identity.js";
import { type Address, isChainId, normalizeAddress } from "../identity.js";
import { callService } from "./call.js";
import { buildEnvelope } from "./envelope.js";
import { signedFetch } from "./http.js";
import { signingTransport } from "./transport.js";
import type { CallInfo, Signer, SignerOptions } from "./types.js";

const DEFAULT_CHAIN = "eip155:480";
const DEFAULT_EXPIRY = 120;

function processEnv(): Env {
  return { ...(globalThis.process?.env ?? {}) };
}

function expiryOf(value: number | undefined): number {
  const expiry = value ?? DEFAULT_EXPIRY;
  if (!Number.isInteger(expiry) || expiry <= 0 || expiry > 3600) {
    throw new HorsError("CONFIG_INVALID", "expirySeconds must be a positive integer ≤ 3600");
  }
  return expiry;
}

export async function createSigner(options: SignerOptions = {}): Promise<Signer> {
  const env = processEnv();
  const profile = options.profile ?? nonEmpty(env.HORS_PROFILE) ?? "default";
  if (!PROFILE_NAME.test(profile)) {
    throw new HorsError("CONFIG_INVALID", "profile name is invalid");
  }
  const chainId = options.chainId ?? DEFAULT_CHAIN;
  if (!isChainId(chainId)) {
    throw new HorsError("CONFIG_INVALID", "chainId must be eip155:<positive integer>");
  }
  const expirySeconds = expiryOf(options.expirySeconds);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  let address: Address;
  let humanId: HumanId | null = null;
  let account: {
    address: string;
    signMessage: (args: { message: string }) => Promise<`0x${string}`>;
  };

  let profileMod: typeof import("../config/profile.js") | undefined;

  if (options.account !== undefined) {
    if (options.account.address === undefined || options.account.signMessage === undefined) {
      throw new HorsError("CONFIG_INVALID", "account must expose address and signMessage");
    }
    address = normalizeAddress(options.account.address);
    account = options.account;
  } else {
    const key = env.HORS_PRIVATE_KEY;
    if (key !== undefined && key !== "") {
      if (!isPrivateKey(key)) {
        throw new HorsError(
          "CONFIG_INVALID",
          "HORS_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
        );
      }
      const derived = privateKeyToAccount(key);
      address = normalizeAddress(derived.address);
      account = derived;
    } else {
      const { readKeyFile } = await import("../config/keyfile.js");
      profileMod = await import("../config/profile.js");
      const derived = privateKeyToAccount(await readKeyFile(profileMod.profileHome(env), profile));
      address = normalizeAddress(derived.address);
      account = derived;
    }
  }

  try {
    profileMod ??= await import("../config/profile.js");
    const loaded = await profileMod.readProfile(profileMod.profileHome(env), profile);
    humanId = loaded?.humanId ?? null;
  } catch (error) {
    if (options.account === undefined) {
      throw error;
    }
    // createSigner({ account }) must work on runtimes without node:fs; a
    // missing or unreadable profile is not fatal when the caller supplied the account.
  }

  const signer: Signer = {
    address,
    humanId,
    sign(call: CallInfo) {
      return buildEnvelope({
        account,
        url: call.url,
        fn: call.fn,
        argsHash: call.argsHash,
        chainId,
        expirySeconds,
      });
    },
    wrapTransport(transport, opts) {
      return signingTransport(transport, signer, {
        url: opts.url,
        meta: opts.meta ?? options.meta,
      });
    },
    fetch: (input, init) => signedFetch(signer, fetchImpl, options.meta)(input, init),
    call(service, fn, args, opts) {
      return callService(
        signer,
        { services: options.services, rpc: options.rpc, cache: options.cache, fetch: fetchImpl },
        service,
        fn,
        args,
        opts,
      );
    },
  };
  return signer;
}
