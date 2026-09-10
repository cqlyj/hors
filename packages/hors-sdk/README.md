# hors-sdk

CORS for AI agents: gate the functions your MCP server or HTTP API exposes by the
anonymous World ID human behind the calling agent — `same-human`, `any-human`, `public`,
an allow list, or a rule of your own.

```sh
npm i hors-sdk @modelcontextprotocol/server @worldcoin/agentkit-core viem zod
```

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { hors } from "hors-sdk/mcp";
import { z } from "zod";

const server = new McpServer({ name: "work", version: "1.0.0" });
const gated = await hors(server);
gated.registerTool(
  "approve",
  { inputSchema: z.object({ amount: z.number() }), hors: "same-human" },
  async ({ amount }, ctx) => ({
    content: [{ type: "text", text: `approved ${amount} for ${ctx.hors.callerHumanId}` }],
  }),
);
```

Then, in the service directory, `npx -y hors-cli init` and
`npx -y hors-cli connect --profile <name>` to create the service wallet and pin its owner.

Entry points: `hors-sdk` (gate, config, policies), `hors-sdk/mcp`, `hors-sdk/http`,
`hors-sdk/client` (sign calls), `hors-sdk/resolvers`, `hors-sdk/node`, `hors-sdk/world`.
Node ≥ 22.18.

Documentation: [SDK reference](https://github.com/cqlyj/hors/blob/main/docs/sdk.md) ·
[CLI and MCP bridge](https://github.com/cqlyj/hors/blob/main/docs/cli.md) ·
[repository](https://github.com/cqlyj/hors)
