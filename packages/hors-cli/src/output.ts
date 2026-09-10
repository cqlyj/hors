import type { Flags, Io } from "./io.js";

export type Outcome =
  | {
      type: "ok";
      lines?: string[];
      json?: unknown;
      jsonLines?: unknown[];
      info?: string[];
      warn?: string[];
      exit?: 0 | 1;
    }
  | { type: "deny"; code: string; reason: string; challenge: unknown }
  | { type: "err"; exit: 1 | 2 | 4; code: string; message: string; info?: string[] };

export function oneLineField(text: string): string {
  let out = "";
  for (const ch of text) {
    out += ch === "\r" || ch === "\n" || ch === "\t" ? " " : ch;
  }
  return out;
}

function sanitizeLine(line: string): string {
  let out = "";
  for (const ch of line) {
    const code = ch.charCodeAt(0);
    out +=
      code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out;
}

function humanOut(io: Io, line: string): void {
  io.stdout(sanitizeLine(line));
}

export function writeOut(io: Io, text: string): void {
  humanOut(io, text.endsWith("\n") ? text.slice(0, -1) : text);
}

export function writeErr(io: Io, text: string): void {
  io.stderr(text.endsWith("\n") ? text.slice(0, -1) : text);
}

function printInfo(io: Io, flags: Flags, lines: string[] | undefined): void {
  if (flags.quiet || lines === undefined) {
    return;
  }
  for (const line of lines) {
    humanOut(io, line);
  }
}

export function present(io: Io, flags: Flags, outcome: Outcome): number {
  if (outcome.type === "ok") {
    if (flags.json) {
      if (outcome.jsonLines !== undefined) {
        for (const row of outcome.jsonLines) {
          io.stdout(JSON.stringify(row));
        }
      } else {
        io.stdout(JSON.stringify(outcome.json ?? {}));
      }
    } else {
      for (const line of outcome.lines ?? []) {
        humanOut(io, line);
      }
      printInfo(io, flags, outcome.info);
    }
    for (const line of outcome.warn ?? []) {
      io.stderr(line);
    }
    return outcome.exit ?? 0;
  }
  if (outcome.type === "deny") {
    if (flags.json) {
      io.stdout(
        JSON.stringify({
          ok: false,
          code: outcome.code,
          reason: outcome.reason,
          challenge: outcome.challenge,
        }),
      );
    } else {
      humanOut(io, `denied ${outcome.code}: ${outcome.reason}`);
      if (outcome.challenge !== null && outcome.challenge !== undefined) {
        humanOut(io, `challenge: ${JSON.stringify(outcome.challenge)}`);
      }
    }
    return 3;
  }
  printInfo(io, flags, outcome.info);
  const message = outcome.message;
  if (flags.json) {
    io.stdout(JSON.stringify({ error: { code: outcome.code, message } }));
  } else {
    io.stderr(`error: ${message}`);
  }
  return outcome.exit;
}
