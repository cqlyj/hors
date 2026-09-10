import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HorsError } from "../errors.js";
import { isPlainObject } from "../plain.js";
import { isErrno } from "./errno.js";

async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, file);
}

export async function readAddressBook(home: string): Promise<Record<string, string>> {
  const file = join(home, "services.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return {};
    }
    throw new HorsError("CONFIG_INVALID", `services.json is not readable: ${file}`, undefined, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HorsError("CONFIG_INVALID", `services.json is not valid JSON: ${file}`);
  }
  if (!isPlainObject(parsed)) {
    throw new HorsError("CONFIG_INVALID", `services.json must be an object: ${file}`);
  }
  const book: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new HorsError("CONFIG_INVALID", `services.json must map names to strings: ${file}`);
    }
    book[key] = value;
  }
  return book;
}

export async function writeAddressBook(home: string, book: Record<string, string>): Promise<void> {
  for (const value of Object.values(book)) {
    if (typeof value !== "string") {
      throw new HorsError("CONFIG_INVALID", "address book values must be strings");
    }
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const sorted = Object.fromEntries(
    Object.entries(book).sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeAtomic(join(home, "services.json"), `${JSON.stringify(sorted)}\n`);
}
