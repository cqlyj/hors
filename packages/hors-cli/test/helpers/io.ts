import type { AgentBook } from "hors-sdk/world";
import { type Io, UsageError } from "../../src/io.js";

export function fakeIo(opts: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  isTTY?: boolean;
  confirmAnswers?: boolean[];
  spawnResult?: number | null | ((command: string, args: readonly string[]) => number | null);
  agentBook?: AgentBook;
  fetch?: typeof fetch;
  now?: () => number;
  worldChainBlock?: Io["worldChainBlock"];
}): {
  io: Io;
  out: string[];
  err: string[];
  spawns: Array<{ command: string; args: readonly string[] }>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const answers = [...(opts.confirmAnswers ?? [])];
  const io: Io = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    env: opts.env ?? {},
    cwd: opts.cwd ?? "/tmp",
    isTTY: opts.isTTY === true,
    async confirm(question) {
      if (opts.isTTY !== true) {
        throw new UsageError("confirmation needs a TTY or --yes");
      }
      const next = answers.shift();
      if (next === undefined) {
        throw new UsageError(`unexpected confirm: ${question}`);
      }
      return next;
    },
    async spawn(command, args) {
      spawns.push({ command, args });
      if (typeof opts.spawnResult === "function") {
        return opts.spawnResult(command, args);
      }
      return opts.spawnResult ?? 0;
    },
    now: opts.now ?? Date.now,
    fetch: opts.fetch,
    agentBook: opts.agentBook,
    worldChainBlock: opts.worldChainBlock,
  };
  return { io, out, err, spawns };
}

export function blob(out: string[], err: string[]): string {
  return `${out.join("\n")}\n${err.join("\n")}`;
}
