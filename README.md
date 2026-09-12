# HORS — Human-Origin Resource Sharing

[![hors-sdk](https://img.shields.io/npm/v/hors-sdk?label=hors-sdk)](https://www.npmjs.com/package/hors-sdk)
[![hors-cli](https://img.shields.io/npm/v/hors-cli?label=hors-cli)](https://www.npmjs.com/package/hors-cli)

CORS for AI agents. A browser asks *which origin is this request from?*; HORS asks *which
human is behind the agent making this call?* — and answers with an anonymous, unforgeable
World ID identity, so an MCP server or HTTP API can say "only my own human", "any verified
human", or anything in between, without accounts, API keys or shared secrets.

| CORS                              | HORS                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `Origin` header                   | Signed envelope: agent wallet → World ID `humanId`        |
| Preflight (`OPTIONS`)             | Unsigned `tools/list` shows each function's policy         |
| `Access-Control-Allow-Origin`     | `same-human` · `any-human` · `public` · a humanId · a rule |
| Blocked by the browser            | Denied by the gate, with a machine-readable reason        |

## How it works

1. Every agent has a wallet. A human proves once, in World App, that they are a real and
   unique person behind that wallet; the proof is a `humanId` in World's AgentBook.
2. Each call carries a signed envelope binding the caller's address, the target host and
   path, a hash of the arguments and a nonce. It expires in five minutes and cannot be
   replayed.
3. The gate verifies the signature, looks the address up in AgentBook, and applies the
   function's policy. The service sees `ctx.hors.callerHumanId`, never a login.
4. Denials come back as results, not errors — optionally with a **challenge** the human
   can satisfy — so agents can explain, ask, and retry.

Two packages, one version: **`hors-sdk`** gates your service and signs calls; **`hors-cli`**
(`hors`) creates identities, inspects and calls gated services, and bridges any MCP host to
them. Always invoke the CLI as `npx -y hors-cli`, never `npx hors`.

## Quick start

### 1. Gate an MCP server

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

`hors(server)` returns the same server with a gated `registerTool`: every tool gets a
policy (`same-human` by default), `tools/list` publishes the policies, and unsigned or
foreign calls are denied before your handler runs.

### 2. Give the service an identity

```sh
npx -y hors-cli init                    # writes hors.config.ts (profile = package name)
npx -y hors-cli connect --profile work  # creates the wallet, shows a World App QR, pins the owner
```

`same-human` now means "the human who scanned that QR". The wallet lives under `~/.hors/work/`.

### 3. Call it

From a shell, with a profile of your own:

```sh
npx -y hors-cli connect --profile me
npx -y hors-cli list https://svc.example/mcp                     # tools and policies, unsigned
npx -y hors-cli call https://svc.example/mcp approve '{"amount":1}'
```

From an MCP host, through the bridge:

```sh
codex mcp add hors -- npx -y hors-cli mcp --profile codex
npx -y hors-cli connect --profile codex
```

The host gains `hors_status`, `hors_services`, `hors_add_service`, `hors_list` and
`hors_call`; the agent calls gated services as its human, and denials arrive as readable
results.

## Policies

```ts
hors: "same-human"                                  // the service owner's human (default)
hors: "any-human"                                   // any verified human
hors: "public"                                      // anyone, even unsigned
hors: { origin: ["0xabc…", "0xdef…"] }              // an allow list of humans
hors: {
  origin: "any-human",
  rule: (ctx) =>
    (ctx.args as { amount: number }).amount <= 100 || {
      deny: "amount exceeds limit",
      challenge: { type: "approval", limit: 100 },  // returned to the caller's human
    },
}
```

Rules get the full call context (caller, arguments, function, a per-gate `Store`) and can
be async; middleware (`use`) runs after them for logging, rate limits or audit. Policies are
per tool, per service (`hors.config.ts`), or shared via `definePolicy`. The same gate
protects plain HTTP routes with `hors-sdk/http`.

## Try it without World App

Same `hors()` as the quick start, served over HTTP. Save as `server.mjs` and add
`@hono/node-server` (any fetch-standard server works):

```js
import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { hors } from "hors-sdk/mcp";
import { z } from "zod";

const handler = createMcpHandler(async () => {
  const server = new McpServer({ name: "work", version: "1.0.0" });
  const gated = await hors(server, { transport: "http" });
  gated.registerTool(
    "approve",
    { inputSchema: z.object({ amount: z.number() }), hors: "same-human" },
    async ({ amount }, ctx) => ({
      content: [{ type: "text", text: `approved ${amount} for ${ctx.hors.callerHumanId}` }],
    }),
  );
  return server;
});

serve({ fetch: handler.fetch, port: 8787, hostname: "127.0.0.1" });
```

```sh
npx -y hors-cli connect --profile work  --no-register --home /tmp/h
npx -y hors-cli connect --profile other --no-register --home /tmp/h
HORS_MOCK=1 HORS_HOME=/tmp/h HORS_PROFILE=work node server.mjs   # mock registry; leave this running
```

In another terminal:

```sh
npx -y hors-cli call http://127.0.0.1:8787/mcp approve '{"amount":1}' --profile work  --home /tmp/h   # passes
npx -y hors-cli call http://127.0.0.1:8787/mcp approve '{"amount":1}' --profile other --home /tmp/h   # HORS_ORIGIN_MISMATCH
```

Signatures and envelopes are real; only the identity registry is mocked, and only on the
service side. A gate refuses mock mode under `NODE_ENV=production`.

## Documentation

- [SDK reference](docs/sdk.md) — MCP and HTTP adapters, policies, context, configuration,
  errors, the client, resolvers, deployment.
- [CLI and MCP bridge](docs/cli.md) — profiles, every command, exit codes, the `hors mcp`
  tools, mock mode, troubleshooting.
- [Changelog](CHANGELOG.md)

## Packages

| Package                         | npm                                                                    | What it is                                                       |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`hors-sdk`](packages/hors-sdk) | [`hors-sdk`](https://www.npmjs.com/package/hors-sdk) `0.1.0`           | Gate, MCP and HTTP adapters, policies, client signer, resolvers. |
| [`hors-cli`](packages/hors-cli) | [`hors-cli`](https://www.npmjs.com/package/hors-cli) `0.1.0`           | `hors` binary: `init`, `connect`, `list`, `call`, `mcp`, …        |

Requirements: Node ≥ 22.18 (native TypeScript config loading), World App for registration.
`hors-sdk` peers: `viem`, `@worldcoin/agentkit-core`, and `@modelcontextprotocol/server`
or `/client` for the sides you use.

## Development

```sh
nvm use          # Node 24
pnpm install
pnpm check       # biome + tsc + vitest
```

## License

[MIT](LICENSE) © cqlyj
