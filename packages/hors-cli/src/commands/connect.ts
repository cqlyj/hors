import { readdir } from "node:fs/promises";
import { createProfile, PROFILE_NAME, readProfile, writeProfile } from "hors-sdk/node";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { hasKey, loadCallerConfig } from "../profile.js";
import { registerOnChain } from "../register.js";
import { connectCommand } from "../util.js";
import { agentBookFor } from "../world.js";
import { hijackWarning } from "./status.js";

const TTY_NEEDED =
  "hors connect needs a terminal: the World App QR is shown here. Run it in a visible terminal, or pass --no-register to only create the profile";

async function otherHumanWarning(
  home: string,
  current: string,
  humanId: string,
): Promise<string[]> {
  const warn: string[] = [];
  let names: string[];
  try {
    names = await readdir(home);
  } catch {
    return warn;
  }
  for (const name of names) {
    if (name === current || !PROFILE_NAME.test(name)) {
      continue;
    }
    const other = await readProfile(home, name);
    if (other?.humanId !== undefined && other.humanId !== humanId) {
      warn.push(`warning: profile ${name} belongs to a different human`);
    }
  }
  return warn;
}

export async function runConnect(
  io: Io,
  flags: Flags,
  opts: { label?: string; noRegister?: boolean },
): Promise<Outcome> {
  let created = false;
  let record = await readProfile(flags.home, flags.profile);
  if (!(await hasKey(flags.home, flags.profile))) {
    record = await createProfile(
      flags.home,
      flags.profile,
      opts.label === undefined ? undefined : { label: opts.label },
    );
    created = true;
  }
  if (record === undefined) {
    record = await readProfile(flags.home, flags.profile);
  }
  if (record === undefined) {
    return {
      type: "err",
      exit: 1,
      code: "CONFIG_INVALID",
      message: "profile is missing after create",
    };
  }
  const info = created ? [`created profile ${flags.profile} (${record.address})`] : [];
  if (opts.noRegister === true) {
    return {
      type: "ok",
      info: [...info, `next: ${connectCommand(flags.profile, flags.homeFlag)} (in a terminal)`],
      json: {
        profile: flags.profile,
        address: record.address,
        humanId: record.humanId ?? null,
        created,
        registered: false,
      },
    };
  }

  const loaded = await loadCallerConfig(io, flags);
  const rpcUrl = "config" in loaded ? loaded.config.rpc.worldchain : undefined;
  const book = agentBookFor(io, rpcUrl);

  if (record.humanId !== undefined) {
    const live = await book.lookupHuman(record.address);
    if (live === record.humanId) {
      return {
        type: "ok",
        info,
        lines: [`connected: ${record.humanId}`],
        json: {
          profile: flags.profile,
          address: record.address,
          humanId: record.humanId,
          created,
          registered: false,
        },
      };
    }
    const warning = hijackWarning(record.address, flags.profile, flags.homeFlag);
    io.stderr(warning);
    if (!io.isTTY || flags.json) {
      return {
        type: "err",
        exit: 1,
        code: "REGISTRATION_FAILED",
        message: warning,
        info,
      };
    }
    if (!(await io.confirm("Re-register this wallet now? [y/N] "))) {
      return { type: "err", exit: 1, code: "ABORTED", message: "aborted", info };
    }
  }

  if (!io.isTTY) {
    return {
      type: "err",
      exit: 1,
      code: "REGISTRATION_FAILED",
      message: TTY_NEEDED,
      info,
    };
  }

  io.stderr(`registering ${record.address} with World ID — scan the QR in World App`);
  const humanId = await registerOnChain(io, record.address, book, rpcUrl);
  const registeredAt = new Date(io.now()).toISOString();
  await writeProfile(flags.home, flags.profile, { ...record, humanId, registeredAt });
  const warn = await otherHumanWarning(flags.home, flags.profile, humanId);
  return {
    type: "ok",
    info,
    lines: [`connected: ${humanId}`],
    warn,
    json: {
      profile: flags.profile,
      address: record.address,
      humanId,
      created,
      registered: true,
    },
  };
}
