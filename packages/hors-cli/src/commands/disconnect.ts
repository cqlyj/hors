import { deleteProfile, readProfile } from "hors-sdk/node";
import { type Flags, type Io, UsageError } from "../io.js";
import type { Outcome } from "../output.js";
import { notConnected } from "../util.js";

export async function runDisconnect(
  io: Io,
  flags: Flags,
  opts: { yes?: boolean },
): Promise<Outcome> {
  const record = await readProfile(flags.home, flags.profile);
  if (record === undefined) {
    return notConnected(flags.profile);
  }
  io.stderr(`deleting profile ${flags.profile} (${record.address})`);
  if (opts.yes !== true) {
    if (!io.isTTY) {
      throw new UsageError("disconnect needs a TTY or --yes");
    }
    if (!(await io.confirm("Delete this profile and its key? [y/N] "))) {
      return { type: "err", exit: 1, code: "ABORTED", message: "aborted" };
    }
  }
  await deleteProfile(flags.home, flags.profile);
  return {
    type: "ok",
    lines: [`deleted ${flags.profile}`],
    json: { profile: flags.profile, address: record.address, deleted: true },
  };
}
