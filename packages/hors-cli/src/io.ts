import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { AgentBook } from "hors-sdk/world";

export class UsageError extends Error {
  readonly code = "USAGE";
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Flags {
  readonly profile: string;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly home: string;
  /** Set only when `--home` was on the command line, not when `HORS_HOME` supplied the path. */
  readonly homeFlag?: string;
}

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly isTTY: boolean;
  confirm(question: string): Promise<boolean>;
  spawn(command: string, args: readonly string[]): Promise<number | null>;
  now(): number;
  sleep?(ms: number): Promise<void>;
  fetch?: typeof fetch;
  agentBook?: AgentBook;
  worldChainBlock?: (rpcUrl: string | undefined) => Promise<{ number: bigint; timestamp: bigint }>;
}

export function nodeIo(): Io {
  return {
    stdout: (text) => {
      process.stdout.write(`${text}\n`);
    },
    stderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    async confirm(question) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        throw new UsageError("confirmation needs a TTY or --yes");
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(question);
        return /^(y|yes)$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    spawn(command, args) {
      return new Promise((resolve) => {
        const child = spawn(command, [...args], { stdio: "inherit" });
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      });
    },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
