import { isPlainObject } from "hors-sdk";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { cliSigner, optionalConfig } from "../profile.js";
import { parseObjectJson } from "../util.js";

export async function runCall(
  io: Io,
  flags: Flags,
  service: string,
  fn: string,
  json?: string,
  metaJson?: string,
): Promise<Outcome> {
  const args = json === undefined ? undefined : parseObjectJson(json, "[json]");
  const meta = metaJson === undefined ? undefined : parseObjectJson(metaJson, "--meta");
  const config = await optionalConfig(io, flags);
  const signer = await cliSigner(flags.home, flags.profile, config, io.fetch);
  const outcome = await signer.call(service, fn, args, meta === undefined ? undefined : { meta });
  if (!outcome.ok) {
    return {
      type: "deny",
      code: outcome.code,
      reason: outcome.reason,
      challenge: outcome.challenge,
    };
  }
  const lines = (outcome.result.content ?? []).map((item) => {
    if (isPlainObject(item) && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
    return JSON.stringify(item);
  });
  return {
    type: "ok",
    lines,
    json: { ok: true, result: outcome.result, hors: outcome.hors },
  };
}
