import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveProfileName, initTemplate } from "../init-template.js";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { connectCommand } from "../util.js";

export async function defaultInitName(io: Io): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(io.cwd, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (typeof pkg.name === "string" && pkg.name !== "") {
      return deriveProfileName(pkg.name);
    }
  } catch {
    // Fallback when package.json is missing or unreadable.
  }
  return deriveProfileName(path.basename(io.cwd));
}

export async function runInit(
  io: Io,
  flags: Flags,
  opts: { force?: boolean; name: string },
): Promise<Outcome> {
  const name = opts.name;
  const file = path.join(io.cwd, "hors.config.ts");
  try {
    await access(file);
    if (opts.force !== true) {
      return {
        type: "err",
        exit: 1,
        code: "CONFIG_INVALID",
        message: "hors.config.ts exists; pass --force to overwrite",
      };
    }
  } catch {
    // Write when no hors.config.ts exists yet.
  }
  await writeFile(file, initTemplate(name), "utf8");
  return {
    type: "ok",
    lines: [`wrote hors.config.ts (profile ${name})`],
    info: [`next: ${connectCommand(name, flags.homeFlag)}`],
    json: { file, profile: name },
  };
}
