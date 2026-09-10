import type { Address, HumanId } from "hors-sdk";
import { HorsError } from "hors-sdk";
import type { AgentBook } from "hors-sdk/world";
import type { Io } from "./io.js";
import { agentBookFor } from "./world.js";

export const WORLD_CLI = "@worldcoin/agentkit-cli@0.2.0";

function worldRegisterSpawn(address: string): { command: string; args: string[] } {
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", WORLD_CLI, "register", address],
  };
}

async function waitForNonce(
  io: Io,
  book: AgentBook,
  address: Address,
  n0: bigint,
): Promise<boolean> {
  const started = io.now();
  let last = started;
  for (let poll = 0; poll < 40; poll++) {
    if ((await book.getNextNonce(address)) > n0) {
      return true;
    }
    if (io.now() - started >= 120_000) {
      return false;
    }
    const now = io.now();
    if (now - last < 3000 && io.sleep !== undefined) {
      const remain = 120_000 - (now - started);
      if (remain > 0) {
        await io.sleep(Math.min(3000 - (now - last), remain));
      }
    }
    last = io.now();
  }
  return (await book.getNextNonce(address)) > n0;
}

export async function registerOnChain(
  io: Io,
  address: Address,
  book: AgentBook,
  rpcUrl: string | undefined,
): Promise<HumanId> {
  const n0 = await book.getNextNonce(address);
  const { command, args } = worldRegisterSpawn(address);
  await io.spawn(command, args);
  if (!(await waitForNonce(io, book, address, n0))) {
    throw new HorsError(
      "REGISTRATION_FAILED",
      "registration did not land on World Chain within 120 s",
    );
  }
  // fresh client: never one that may hold a cached null
  const humanId = await agentBookFor(io, rpcUrl).lookupHuman(address);
  if (humanId === null) {
    throw new HorsError("REGISTRATION_FAILED", "lookupHuman returned null after registration");
  }
  return humanId;
}
