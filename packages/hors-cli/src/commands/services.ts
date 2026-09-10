import { readAddressBook, writeAddressBook } from "hors-sdk/node";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { assertServiceName, assertServiceUri } from "../service-uri.js";

export async function runServices(
  _io: Io,
  flags: Flags,
  action?: { op: "add"; name: string; uri: string } | { op: "rm"; name: string },
): Promise<Outcome> {
  const book = await readAddressBook(flags.home);
  if (action === undefined) {
    const names = Object.keys(book).sort((a, b) => a.localeCompare(b));
    return {
      type: "ok",
      lines: names.map((name) => `${name}  ${book[name]}`),
      jsonLines: names.map((name) => ({ name, uri: book[name] })),
    };
  }
  if (action.op === "add") {
    assertServiceName(action.name);
    assertServiceUri(action.uri);
    await writeAddressBook(flags.home, { ...book, [action.name]: action.uri });
    return {
      type: "ok",
      lines: [`added ${action.name} → ${action.uri}`],
      json: { name: action.name, uri: action.uri },
    };
  }
  if (!Object.hasOwn(book, action.name)) {
    return {
      type: "err",
      exit: 1,
      code: "RESOLVER_FAILED",
      message: `unknown service ${action.name}`,
    };
  }
  const next = { ...book };
  delete next[action.name];
  await writeAddressBook(flags.home, next);
  return { type: "ok", lines: [`removed ${action.name}`], json: { name: action.name } };
}
