import { createBridge } from "../bridge/server.js";
import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";

export async function runMcp(io: Io, flags: Flags): Promise<Outcome> {
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  const server = createBridge({
    home: flags.home,
    profile: flags.profile,
    env: { ...io.env, HORS_HOME: flags.home },
    cwd: io.cwd,
    fetch: io.fetch,
    agentBook: io.agentBook,
    log: (line) => {
      io.stderr(line);
    },
  });
  const handle = serveStdio(() => server);
  await new Promise<void>((resolve) => {
    const done = () => {
      void handle.close().finally(resolve);
    };
    if (process.stdin.readableEnded) {
      done();
      return;
    }
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
  return { type: "ok" };
}
