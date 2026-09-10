import { MockAgentBook } from "hors-sdk/world";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { loadCallerConfig, openProfile } from "../profile.js";

export async function runWhoami(io: Io, flags: Flags): Promise<Outcome> {
  const loaded = await loadCallerConfig(io, flags);
  const mock = "config" in loaded && loaded.config.mock;
  const opened = await openProfile(flags, !mock);
  if ("outcome" in opened) {
    return opened.outcome;
  }
  const pin = opened.record.humanId;
  if (!mock && pin !== undefined) {
    return { type: "ok", lines: [pin], json: { humanId: pin } };
  }
  // In mock mode every wallet is its mock humanId, pinned or not.
  const humanId = MockAgentBook.humanIdOf(opened.record.address);
  return {
    type: "ok",
    lines: [humanId],
    json: { humanId, mock: true },
    warn: ["warning: mock identity (HORS_MOCK)"],
  };
}
