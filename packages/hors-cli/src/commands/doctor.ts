import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readProfile } from "hors-sdk/node";
import { MockAgentBook } from "hors-sdk/world";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { loadCallerConfig } from "../profile.js";
import { connectCommand, thrownMessage } from "../util.js";
import { lookupLive, worldChainBlock } from "../world.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function runDoctor(io: Io, flags: Flags): Promise<Outcome> {
  const checks: Check[] = [];
  const loaded = await loadCallerConfig(io, flags);
  if ("error" in loaded) {
    checks.push({ name: "config", status: "fail", detail: thrownMessage(loaded.error) });
  } else if (loaded.path === undefined) {
    checks.push({ name: "config", status: "ok", detail: "no config file (defaults)" });
  } else {
    checks.push({ name: "config", status: "ok", detail: loaded.path });
  }
  const config = "config" in loaded ? loaded.config : undefined;
  const rpcUrl = config?.rpc.worldchain;
  const getBlock = io.worldChainBlock ?? worldChainBlock;
  let block: { number: bigint; timestamp: bigint } | undefined;
  try {
    block = await getBlock(rpcUrl);
    checks.push(
      rpcUrl === undefined
        ? {
            name: "rpc",
            status: "warn",
            detail: "using the public default World Chain RPC; set rpc.worldchain in production",
          }
        : { name: "rpc", status: "ok", detail: `block ${block.number}` },
    );
  } catch (error) {
    checks.push({ name: "rpc", status: "fail", detail: thrownMessage(error) });
  }
  if (block !== undefined) {
    const skew = Math.abs(Math.floor(io.now() / 1000) - Number(block.timestamp));
    checks.push(
      skew > 60
        ? { name: "clock", status: "warn", detail: `clock skew ${skew}s against World Chain` }
        : { name: "clock", status: "ok", detail: `skew ${skew}s` },
    );
  }

  const mock = config?.mock === true;
  const record = await readProfile(flags.home, flags.profile);
  if (record === undefined) {
    checks.push({
      name: "profile",
      status: "fail",
      detail: `not found — run ${connectCommand(flags.profile, flags.homeFlag)}`,
    });
  } else if (mock) {
    const humanId = MockAgentBook.humanIdOf(record.address);
    checks.push({
      name: "identity",
      status: "ok",
      detail: `${humanId} (mock)`,
    });
  } else if (record.humanId === undefined) {
    checks.push({ name: "profile", status: "warn", detail: "created but not registered" });
  } else {
    checks.push({
      name: "profile",
      status: "ok",
      detail: `${record.address} pinned ${record.humanId}`,
    });
  }

  if (process.platform !== "win32") {
    try {
      const info = await stat(join(flags.home, flags.profile, "key"));
      if ((info.mode & 0o077) !== 0) {
        checks.push({
          name: "key",
          status: "fail",
          detail: "key file is readable by others (chmod 600 …)",
        });
      } else {
        checks.push({ name: "key", status: "ok", detail: "0600" });
      }
    } catch {
      // no key
    }
  }

  if (!mock && record?.humanId !== undefined && block !== undefined && config !== undefined) {
    const looked = await lookupLive(io, record.address, config.rpc.worldchain);
    checks.push(
      looked.error !== undefined
        ? { name: "registration", status: "fail", detail: looked.error }
        : looked.live !== record.humanId
          ? {
              name: "registration",
              status: "fail",
              detail: "on-chain registration differs from the pin (hijack?) — run hors connect",
            }
          : { name: "registration", status: "ok", detail: "matches pin" },
    );
  }

  const hasPrivateKey = io.env.HORS_PRIVATE_KEY !== undefined && io.env.HORS_PRIVATE_KEY !== "";
  const hasOwnerEnv = io.env.HORS_OWNER !== undefined && io.env.HORS_OWNER !== "";
  const pinned = record?.humanId !== undefined;
  if (hasPrivateKey && !hasOwnerEnv && !pinned) {
    checks.push({
      name: "owner",
      status: "warn",
      detail:
        "HORS_PRIVATE_KEY without HORS_OWNER or a pinned profile: same-human cannot resolve an owner",
    });
  } else if (hasOwnerEnv || pinned) {
    checks.push({ name: "owner", status: "ok", detail: "resolved" });
  }

  const failed = checks.some((check) => check.status === "fail");
  return {
    type: "ok",
    lines: checks.map((check) => `${check.status}  ${check.name}: ${check.detail}`),
    json: { ok: !failed, checks },
    exit: failed ? 1 : 0,
  };
}
