import type { Flags, Io } from "../io.js";
import type { Outcome } from "../output.js";
import { oneLineField } from "../output.js";
import { callerOptions, optionalConfig } from "../profile.js";
import { listRemote, renderPolicy, summariseSchema } from "../remote.js";

export async function runList(io: Io, flags: Flags, service: string): Promise<Outcome> {
  const config = await optionalConfig(io, flags);
  const tools = await listRemote(service, callerOptions(flags.home, config, io.fetch));
  return {
    type: "ok",
    lines: tools.flatMap((tool) => [
      tool.name,
      `  ${oneLineField(tool.description)}`,
      `  args: ${summariseSchema(tool.inputSchema)}`,
      `  policy: ${oneLineField(renderPolicy(tool.policy))}`,
    ]),
    jsonLines: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      policy: tool.policy,
    })),
  };
}
