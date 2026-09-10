import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HorsError } from "../errors.js";
import { isErrno } from "./errno.js";
import { isPrivateKey } from "./private-key.js";
import { PROFILE_NAME } from "./profile-name.js";

export async function readKeyFile(home: string, profile: string): Promise<`0x${string}`> {
  if (!PROFILE_NAME.test(profile)) {
    throw new HorsError("CONFIG_INVALID", "profile name is invalid");
  }
  const file = path.join(home, profile, "key");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      throw new HorsError(
        "PROFILE_NOT_FOUND",
        `profile "${profile}" is not connected; run: npx -y hors-cli connect --profile ${profile}`,
      );
    }
    throw new HorsError("CONFIG_INVALID", `key file is not readable: ${file}`, undefined, {
      cause: error,
    });
  }
  if (!info.isFile()) {
    throw new HorsError("CONFIG_INVALID", `key file is not a regular file: ${file}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new HorsError("CONFIG_INVALID", "key file must be mode 0600");
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new HorsError("CONFIG_INVALID", `key file is not readable: ${file}`, undefined, {
      cause: error,
    });
  }
  const key = text.replace(/\r?\n$/, "");
  if (!isPrivateKey(key)) {
    throw new HorsError("CONFIG_INVALID", "key file must be a 0x-prefixed 32-byte hex string");
  }
  return key;
}
