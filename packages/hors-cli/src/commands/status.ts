import { MockAgentBook } from "hors-sdk/world";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { loadCallerConfig, openProfile } from "../profile.js";
import { connectCommand, notConnected, thrownMessage } from "../util.js";
import { lookupLive } from "../world.js";

export function hijackWarning(address: string, profile: string, homeFlag?: string): string {
  return `warning: on-chain registration for ${address} no longer matches the pinned humanId; someone may have re-registered this wallet. Fix: ${connectCommand(profile, homeFlag)}`;
}

export async function runStatus(io: Io, flags: Flags): Promise<Outcome> {
  const loaded = await loadCallerConfig(io, flags);
  const mock = "config" in loaded && loaded.config.mock;
  const opened = await openProfile(flags, !mock);
  if ("outcome" in opened) {
    return opened.outcome;
  }
  if ("error" in loaded) {
    return {
      type: "err",
      exit: 1,
      code: "CONFIG_INVALID",
      message: `config: invalid (${thrownMessage(loaded.error)})`,
    };
  }
  const { record } = opened;
  const { config, path } = loaded;
  if (config.mock) {
    const humanId = MockAgentBook.humanIdOf(record.address);
    return {
      type: "ok",
      lines: [
        `profile  ${flags.profile}`,
        `address  ${record.address}`,
        `humanId  ${humanId} (mock)`,
        `config  ${path ?? "none"}`,
        "mock  on",
      ],
      json: {
        profile: flags.profile,
        address: record.address,
        humanId,
        connected: true,
        config: path ?? null,
        mock: true,
      },
    };
  }
  const looked = await lookupLive(io, record.address, config.rpc.worldchain);
  const pinned = record.humanId;
  if (pinned === undefined) {
    return notConnected(flags.profile, flags.homeFlag);
  }
  const live = looked.live;
  const liveError = looked.error;
  const unavailable = liveError !== undefined;
  const hijacked = !unavailable && live !== pinned;
  const lines = [
    `profile  ${flags.profile}`,
    `address  ${record.address}`,
    `humanId  ${pinned}`,
    unavailable ? `live  unavailable (${liveError})` : `live  ${live}`,
    `config  ${path ?? "none"}`,
    "mock  off",
  ];
  const json = {
    profile: flags.profile,
    address: record.address,
    humanId: pinned,
    live: unavailable ? null : live,
    connected: !unavailable && !hijacked,
    hijacked,
    config: path ?? null,
    mock: false,
  };
  if (unavailable) {
    return { type: "ok", lines, json, exit: 1 };
  }
  if (hijacked) {
    return {
      type: "ok",
      lines,
      json,
      warn: [hijackWarning(record.address, flags.profile, flags.homeFlag)],
      exit: 1,
    };
  }
  return { type: "ok", lines, json };
}
