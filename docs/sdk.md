# hors-sdk

`hors-sdk` gates the functions an agent exposes to other agents by the **human** behind
the caller. A caller signs each call with its agent wallet; the gate maps that wallet to
an anonymous World `humanId` through AgentBook and applies a policy such as
`same-human` (only my own agents), `any-human` (any registered human's agents) or
`public`. The service handler never sees a signature or a wallet — it sees `ctx.hors`.

This document is the reference for the package. The command line and the MCP bridge that
hosts use to call gated services are in [cli.md](cli.md).

## Install

```sh
pnpm add hors-sdk viem @worldcoin/agentkit-core
pnpm add @modelcontextprotocol/server    # to gate an MCP server
pnpm add @modelcontextprotocol/client    # only for Signer.call() (loaded on demand)
```

Node ≥ 22.18. `viem` and `@worldcoin/agentkit-core` are peer dependencies; the two MCP
packages are optional peers used only by the entry points that need them.

## Entry points

| Import               | Exports                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `hors-sdk`           | `createGate`, `definePolicy`, `defineConfig`, `hashArgs`, `hashBody`, `isPlainObject`, `MemoryStore`, `HorsError`, types |
| `hors-sdk/mcp`       | `hors(server, options?)` — MCP server adapter                                                                  |
| `hors-sdk/http`      | `hors(policy?, options?)` — Web-standard and Express HTTP adapter                                               |
| `hors-sdk/client`    | `createSigner`, `readResult` — the caller side                                                                 |
| `hors-sdk/resolvers` | `resolve`, `classifyService`, `ens`, `erc8004`, `ERC8004_IDENTITY_REGISTRY`                                    |
| `hors-sdk/world`     | `createAgentBook`, `MockAgentBook`, `AGENTBOOK_ADDRESS`                                                        |
| `hors-sdk/node`      | Node-only: profiles, key file, address book, `loadConfig`                                                      |

## The model in one minute

- **Identity.** Every agent has its own wallet, registered once in World's AgentBook
  through World App (`hors connect`). Two agents of the same human resolve to the same
  `humanId`; a wallet that is not registered is not a human.
- **Owner.** A service's gate knows its own human — the `humanId` pinned in the service's
  profile at `hors connect` time (or `owner`/`HORS_OWNER` in config). `same-human` means
  "caller's human equals the owner". The gate never derives its owner from a live lookup.
- **Envelope.** The caller signs a SIWE (EIP-4361) message binding the endpoint (host and
  path), the function name, a hash of the arguments, a nonce and an expiry. It travels in
  `params._meta["hors/auth"]` over MCP or in the `HORS-Authorization` header over HTTP.
  Tampering, replay and cross-host reuse fail with distinct codes.
- **Local is same-origin.** A call over stdio or an in-memory transport comes from the
  owner's own host and passes `same-human` and `any-human` without an envelope, like a
  same-origin request bypasses CORS. Set `local: "deny"` to require identity everywhere.
- **Policies are public.** Every tool's policy is published in `tools/list` (`_meta["hors/policy"]`)
  and, for HTTP, at `/.well-known/hors.json`, exactly like CORS headers. Rules and
  middleware stay private; listings show only `"custom": true`.

## Gating an MCP server (`hors-sdk/mcp`)

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

`hors(server, options?)` returns the **same** `McpServer` instance with `registerTool`
replaced by a gated version, typed `HorsMcpServer` so the `hors` key and `ctx.hors`
type-check. Keep the original reference for factories (`createMcpHandler`, `serveStdio`)
and register through the returned one.

```ts
interface HorsMcpOptions extends CreateGateOptions {
  gate?: Gate;                    // prebuilt gate; excludes every config key
  transport?: "stdio" | "http";   // force local/remote detection; default: detect
}
```

Rules of the adapter:

- Apply `hors()` **before** `server.connect()`, and only once per instance; both misuses
  throw `CONFIG_INVALID`.
- Every tool registered through the returned instance is gated. `hors: <policy>` sets an
  inline policy; without it the tool gets `functions[name]` from config, else `policy`,
  else `same-human`. There is no way to register an ungated tool on a horsed server.
- Tools registered on the instance **before** `hors()` were applied are refused fail-closed
  with `HORS_POLICY_ERROR: no HORS policy is registered for this tool`; so is a call for an
  unknown tool name.
- The handler receives the MCP SDK's own context with one added property,
  `ctx.hors: HorsContext`. Handlers of tools **without** `inputSchema` receive the context
  as their only argument (MCP SDK convention).
- `RegisteredTool.update()`, `enable()`, `disable()` and `remove()` keep working; a new
  callback is guarded like the original.
- Denials are tool results with `isError: true` and `_meta["hors/result"]` (below), never
  JSON-RPC errors, so hosts show them to the model.

### Local and remote

Over stdio or `InMemoryTransport` the call is local: `ctx.local === true`,
`ctx.transport === "mcp-stdio"`, `callerHumanId === ownerHumanId`, no envelope needed.
Over Streamable HTTP the call is remote (`"mcp-http"`) and needs an envelope unless the
policy includes `public`. `transport: "http"` in the options forces remote treatment (use
it inside `createMcpHandler`); `transport: "stdio"` forces local.

### Serving over HTTP

Create **one** gate per process and hand it to the factory; a `hors(server)` without a
prebuilt gate inside the factory re-reads config and re-resolves the owner on every request.

```js
import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createGate } from "hors-sdk";
import { hors } from "hors-sdk/mcp";

const gate = await createGate();                       // reads hors.config.* from cwd
const handler = createMcpHandler(async () => {
  const server = new McpServer({ name: "work", version: "1.0.0" });
  const gated = await hors(server, { gate, transport: "http" });
  gated.registerTool("ping", { hors: "public" }, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
});
serve({ fetch: handler.fetch, port: 8787 });
```

Any fetch-standard server works (Hono, Bun, Deno, `@hono/node-server`). The expected
URL of a call is derived from the request's `Host` and path; behind a proxy that rewrites
`Host`, either list the public URL in `origins` or set `trustProxy: true` and forward
`X-Forwarded-Host`. See [Deployment](#deployment).

## Gating HTTP routes (`hors-sdk/http`)

```ts
import { hors } from "hors-sdk/http";

const guard = await hors("same-human", { fn: "POST /approve" });

// Web standard (Hono, Bun, Cloudflare, …): the guard runs around the handler
export default {
  fetch: (request) => guard.handle(request, async (request, ctx) => Response.json({ ok: true })),
};

// Express-compatible: sets req.hors = ctx and req.rawBody = Uint8Array
app.post("/approve", guard.express(), handler);   // mount before body parsers
app.all("/.well-known/hors.json", guard.wellKnown());
```

```ts
interface HorsHttpOptions extends CreateGateOptions {
  gate?: Gate;            // prebuilt gate; excludes every config key
  fn?: string;            // declared function id for the well-known listing, e.g. "POST /approve"
  maxBodyBytes?: number;  // default 1_048_576
}
interface HttpGuard {
  readonly gate: Gate;
  handle(request: Request, handler: (request: Request, ctx: HorsContext) => Response | Promise<Response>): Promise<Response>;
  express(): (req, res, next) => void;
  wellKnown(): (req, res) => void;           // GET only; answers other methods 405
  published(): WellKnownDocument;            // { v: 1, functions: [{ fn, policy }] }
}
```

- The function identifier is `<METHOD> <path>`; the arguments hash is over the raw body
  bytes, whatever the `Content-Type`. `ctx.args` is the parsed body for JSON media types,
  else `undefined`.
- The guard reads the body once and re-exposes it: `handle()` passes a replayed `Request`
  to the handler; `express()` sets `req.rawBody`. If a parser ran first, keep the bytes with
  `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`; otherwise the
  guard fails closed with `HORS_POLICY_ERROR` and a log telling you where to mount it.
- Bodies over `maxBodyBytes` are answered `413` before HORS runs.
- Unsigned calls to a non-public route are `401` with `WWW-Authenticate: HORS`; other
  denials use the status of their code. Every HORS-produced response carries a
  `HORS-Result` header (base64 JSON of the `hors/result` object).
- Mount the well-known handler with `app.all` (or `app.use`); with `app.get`, Express
  answers other methods `404` instead of `405`.
- GET and HEAD requests carry no body in the fetch standard. Node's `http` accepts one and
  Express hashes what it receives; do not sign GET bodies.
- Middleware (`use`) on an Express route buffers the downstream response, so streaming
  responses are not supported on routes whose policy has middleware.

## Gating anything else (`Gate`)

```ts
import { createGate } from "hors-sdk";

const gate = await createGate();
const approve = gate.wrap("approve", async (args, ctx) => doApprove(args), "same-human");
await approve({ amount: 1 }, envelope, meta);   // throws HorsError on denial
```

```ts
interface Gate {
  owner(): HumanId | null;                  // null while unresolved
  readonly address: Address | null;
  readonly mock: boolean;
  readonly log: Logger;
  policyFor(fn: string): CompiledPolicy;
  publish(fn: string): PublishedPolicy;
  evaluate(input: EvaluateInput): Promise<Decision>;
  wrap<T>(fn: string, handler: (args: unknown, ctx: HorsContext) => T | Promise<T>, policy?: Policy):
    (args: unknown, envelope?: unknown, meta?: unknown) => Promise<T>;
  reload(partial: Pick<HorsConfig, "deny" | "functions">): void;
  on(event: "audit", listener: (e: AuditEvent) => void): () => void;
}
```

`wrap` treats every call as remote (`transport: "wrap"`); it has no request URL to derive
an expected URL from, so set `origins` in config when the calls are signed. `evaluate` is
the low-level form the two built-in adapters are written on: it returns
`{ ok: true, ctx, result, value }` or `{ ok: false, denial }` and never renders a transport
result itself.

## Policies

```ts
type Policy = "same-human" | "any-human" | "public" | string /* named */ | PolicyObject;

interface PolicyObject {
  origin?: Origin | Origin[];     // default "same-human"; an array is a disjunction
  rule?: Rule | Rule[];           // run in order after origin; all must allow
  use?: Middleware | Middleware[];// around the handler, after origin and rules
  describe?: string;              // published in listings; ≤ 512 chars, no control characters
}

type Origin = "same-human" | "any-human" | "public" | HumanId | ((ctx: HorsContext) => boolean | Promise<boolean>);
type Verdict = boolean | { deny: string; code?: string; challenge?: unknown };
type Rule = (ctx: HorsContext) => Verdict | Promise<Verdict>;
type Middleware = (ctx: HorsContext, next: () => Promise<HorsResult>) => Promise<HorsResult>;
```

### Origins

| Member         | Passes when                                                                         |
| -------------- | ----------------------------------------------------------------------------------- |
| `"same-human"` | local, or `callerHumanId !== null && callerHumanId === ownerHumanId`                |
| `"any-human"`  | local, or the caller's wallet resolves to a `humanId`                               |
| `"public"`     | always; an envelope, if present, is still verified so the caller may be identified  |
| a `HumanId`    | `callerHumanId === literal`                                                         |
| a function     | it returns `true`; evaluated last, only for signed callers, under `ruleTimeoutMs`   |

Failure is `HORS_ORIGIN_MISMATCH`, or `HORS_OWNER_UNRESOLVED` when a remote `same-human`
could not be evaluated because the service has no owner yet.

### Rules, denials and challenges

A rule returns `true`, `false` (→ `HORS_RULE_DENIED`) or a verdict object. `ctx.deny()` is
the same thing as a throw:

```ts
const underBudget: Rule = (ctx) => {
  const { amount } = ctx.args as { amount: number };   // ctx.args is unknown: parse or cast
  return amount <= 500 || {
    deny: "over budget",
    code: "OVER_BUDGET",
    challenge: { type: "approval", limit: 500 },
  };
};
```

- Custom codes match `^[A-Z][A-Z0-9_]{2,63}$`, never start with `HORS_`, and are not SDK
  codes (`CONFIG_INVALID`, `PROFILE_NOT_FOUND`, `RESOLVER_FAILED`, `REGISTRATION_FAILED`).
- Any other exception in policy code — including a thrown `HorsError` with a `HORS_*`
  code — is a policy bug: the caller gets `HORS_POLICY_ERROR` with a fixed reason and the
  message is logged, never sent.
- A `challenge` is any JSON value describing what would satisfy the policy. The caller
  satisfies it out of band and makes a **new** call with proof in `hors/meta`, which the
  rule reads from `ctx.meta`. `hors/meta` is caller-supplied and unsigned: verify what it
  contains.
- Rules and function origins run under `ruleTimeoutMs` (default 10 s); a timeout denies
  with `HORS_POLICY_ERROR`. Handlers are never timed out by the gate.

### Middleware

`use` composes around the handler, outermost first, **after** origin and rules: a rule
denial never reaches middleware; an inner `ctx.deny()` does. A middleware awaits `next()`
at most once and may inspect or replace the result, or short-circuit with a complete
result of the handler's type (audited as `ok`).

```ts
const redact: Middleware = async (ctx, next) => {
  const result = await next();
  return ctx.callerHumanId === ctx.ownerHumanId ? result : stripPrivateFields(result);
};
```

### Named policies and resolution

```ts
import { definePolicy } from "hors-sdk";
definePolicy("under-budget", { origin: "same-human", rule: underBudget, describe: "Owner, up to 500" });
```

Names match `^[a-z][a-z0-9-]{0,63}$`, are process-wide, and cannot be redefined. The
effective policy of a function is the first defined of: the inline policy at
registration; `functions[name]` in config; `policy` in config; `"same-human"`. Unknown
names fail at construction, not on the first call.

### What callers see

Listings publish `{ v: 1, name?, origin, custom, describe? }`. `name` is present for
presets and named policies; `origin` lists the literal members with a `HumanId` shown as
`"human"` and a function as `"custom"`; `custom` is `true` when the policy has any
function origin, rule or middleware. No humanId is ever published.

## `HorsContext`

| Field           | Type                                    | Notes                                                                                  |
| --------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `fn`            | `string`                                | Function identifier (tool name, or `<METHOD> <path>`).                                 |
| `args`          | `unknown`                               | MCP: `params.arguments` as received. HTTP: parsed JSON body or `undefined`. Read-only. |
| `argsHash`      | `string`                                | SHA-256 hex of the canonical arguments (MCP) or the raw body (HTTP).                   |
| `callId`        | `string`                                | From the envelope; a fresh UUID for local calls.                                       |
| `local`         | `boolean`                               | Same-origin call (stdio, in-memory).                                                   |
| `transport`     | `string`                                | `"mcp-stdio"`, `"mcp-http"`, `"http"`, `"wrap"`, or a custom adapter's name.           |
| `callerAddress` | `Address \| null`                       | Verified signer; `null` for anonymous public calls.                                    |
| `callerHumanId` | `HumanId \| null`                       | `null` only for anonymous or unregistered callers of `public` functions, or local calls while the owner is unresolved. |
| `callerChainId` | `string \| null`                        | CAIP-2 chain of the signature.                                                         |
| `ownerHumanId`  | `HumanId \| null`                       | The gate's owner; `null` while unresolved.                                             |
| `policy`        | `{ name?: string; origin: Origin[] }`   | Resolved policy view.                                                                  |
| `meta`          | `Record<string, unknown>`               | `hors/meta` from the caller, `{}` if absent. Unsigned.                                 |
| `state`         | `Record<string, unknown>`               | Per-call scratch space shared by origin functions, rules and middleware.               |
| `store`         | `Store`                                 | The gate's store, namespaced for policies.                                             |
| `now`           | `number`                                | Epoch milliseconds at the start of evaluation.                                         |
| `request`       | `unknown`                               | The transport's native request (MCP server context or `Request`).                      |
| `deny(reason, { code?, challenge? })` | `never`         | Ends the call with a denial from anywhere in policy or handler code.                   |
| `log(level, message, data?)` | `void`                     | Structured logger scoped to the call.                                                  |

Always require `callerHumanId !== null` (or `ctx.local`) before comparing it with
`ownerHumanId`, as the built-in `same-human` does.

## Store

```ts
interface Store {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  incr(key: string, ttlMs?: number): Promise<number>;        // sets the TTL on the first increment
  consumeOnce(key: string, ttlMs: number): Promise<boolean>; // true exactly once per key within TTL
  delete(key: string): Promise<void>;
}
```

The gate uses the store for replay protection and lookup caching; policies get the same
store as `ctx.store` under a `p:` prefix. The default `MemoryStore` is in-process; a
service with more than one replica must pass a shared implementation through
`createGate({ store })`, and its `consumeOnce` must be atomic. Values must be JSON.

```ts
const quota: Rule = async (ctx) => {
  const n = await ctx.store.incr(`quota:${ctx.callerHumanId}`, 3_600_000);
  return n <= 100 || { deny: "quota exceeded", code: "QUOTA_EXCEEDED" };
};
```

## Configuration

`createGate(options?)` merges four layers, highest precedence first: the options passed
in code; environment variables; `hors.config.{ts,mts,js,mjs,json}` in the current
directory (or the path in `HORS_CONFIG` / `options.configFile`); defaults.
`configFile: false` skips the file layer for embeddings that pass everything inline.
`rpc`, `cache`, `dev`, `functions` and `services` merge one level deep; every other key is
replaced wholesale. TypeScript configs load with Node's native type stripping (Node ≥ 22.18).

```ts
// hors.config.ts
import { defineConfig, definePolicy } from "hors-sdk";

definePolicy("under-budget", { origin: "same-human", rule: underBudget, describe: "Owner, up to 500" });

export default defineConfig({
  profile: "work",                      // ~/.hors/work: this service's wallet
  policy: "same-human",                 // default for tools without an inline policy
  functions: { approve: "under-budget", status: "public" },
  services: { finance: "ens:finance.alice.eth" },
});
```

| Key             | Default        | Meaning                                                                                       |
| --------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `owner`         | `"auto"`       | `"auto"` = the humanId pinned in the profile by `hors connect`; or an explicit humanId.        |
| `profile`       | `"default"`    | Profile directory under `HORS_HOME` holding this service's wallet.                            |
| `policy`        | `"same-human"` | Policy for functions with no inline policy and no `functions` entry.                          |
| `functions`     | `{}`           | Per-function policies by name.                                                                |
| `deny`          | `[]`           | Wallet addresses refused on every signed call, whatever the policy.                           |
| `local`         | `"same-human"` | `"deny"` refuses local (stdio) calls: identity is required everywhere.                        |
| `origins`       | derive         | Expected call URLs when the request's `Host`/path cannot be trusted (proxies, `wrap`).        |
| `trustProxy`    | `false`        | Take the expected host from `X-Forwarded-Host`. Only behind a proxy that sets it.             |
| `maxAgeMs`      | `300000`       | Maximum envelope age.                                                                         |
| `clockSkewMs`   | `30000`        | Tolerated clock skew.                                                                         |
| `ruleTimeoutMs` | `10000`        | Bound on rules and function origins.                                                          |
| `rpc.worldchain`| public RPC     | World Chain RPC for AgentBook lookups. Use your own in production.                            |
| `rpc.ens`       | public RPC     | ENS RPC; the URL selects the network (mainnet by default; Sepolia and Holesky work).            |
| `rpc.signatures`| `{}`           | CAIP-2 → RPC URL for ERC-1271 verification on other chains; also used by the ERC-8004 resolver. |
| `cache`         | see below      | `humanTtlMs` 60 s, `nullTtlMs` 10 s, `staleTtlMs` 10 min for AgentBook lookups.               |
| `store`         | `MemoryStore`  | Programmatic only.                                                                            |
| `services`      | `{}`           | Caller-side address book, merged over `<HORS_HOME>/services.json`.                            |
| `dev.mockOrigin`| `false`        | Development mode; refused when `NODE_ENV === "production"`.                                   |

Validation fails fast with `CONFIG_INVALID` on unknown keys, unknown policy names, empty
origin arrays, non-`http(s)` RPC URLs, `origins` with query/fragment/credentials, and out-of-range numbers.

| Environment variable  | Effect                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `HORS_CONFIG`         | Path to the config file (must end in `.ts`, `.mts`, `.js`, `.mjs` or `.json`).              |
| `HORS_HOME`           | Profile directory; default `~/.hors`.                                                       |
| `HORS_PROFILE`        | Profile name; default `default`.                                                            |
| `HORS_OWNER`          | Overrides `owner`: pin the owner on a server without a profile directory.                   |
| `HORS_PRIVATE_KEY`    | Hex key overriding the profile key file (servers, CI). Pair it with `HORS_OWNER`.           |
| `HORS_WORLDCHAIN_RPC` | Overrides `rpc.worldchain`.                                                                 |
| `HORS_MOCK`           | `1` enables development mode.                                                               |
| `HORS_LOG`            | `silent` \| `error` \| `info` \| `debug`; default `info`.                                   |

## Owner and identity

- With `owner: "auto"`, the owner is the humanId pinned in `<HORS_HOME>/<profile>/profile.json`
  by `hors connect`. If the profile is missing or unpinned the gate **starts anyway** with
  the owner unresolved and logs the fix: local calls keep working; remote `same-human`
  denies with `HORS_OWNER_UNRESOLVED`; `any-human` and `public` are unaffected. The gate
  re-reads the pin at most every 10 s, so `hors connect` heals it without a restart.
- The gate never derives the owner from a live AgentBook lookup of its own address:
  anyone can re-register any address, so a live lookup would let a stranger become the
  owner. `hors status` and `hors doctor` compare the pin with the chain and warn.
- AgentBook lookups are cached (`cache.*`); when the RPC fails, a cached human is served
  stale for `staleTtlMs`, an unknown wallet is not, and a cold miss denies with
  `HORS_UNAVAILABLE`. Fail closed.
- `deny` revokes a compromised agent wallet everywhere the human deploys a gate;
  `gate.reload({ deny })` applies it at runtime.

## Results and errors

Success: the handler's result with `_meta["hors/result"]` (MCP) or a `HORS-Result` header (HTTP):

```json
{ "v": 1, "status": "ok", "policy": "same-human", "local": false }
```

Denial (MCP): a tool result with `isError: true`, one text block `"<code>: <reason>"`, and

```json
{ "v": 1, "status": "deny", "code": "HORS_ORIGIN_MISMATCH", "reason": "caller does not match the function's origin", "policy": "same-human", "challenge": null, "local": false }
```

Over HTTP the same object is the JSON body with the status below. `policy` is the preset
or named policy, `null` for inline objects; `"mock": true` appears in development mode.

| Code                     | Meaning                                                              | HTTP |
| ------------------------ | -------------------------------------------------------------------- | ---- |
| `HORS_UNSIGNED`          | No envelope and the function is not public                           | 401  |
| `HORS_BAD_ENVELOPE`      | Envelope unparsable or invalid; oversized `hors/meta` (64 KiB)       | 400  |
| `HORS_DOMAIN_MISMATCH`   | Envelope signed for another host or path                             | 403  |
| `HORS_EXPIRED`           | Too old, from the future, or past `expirationTime`                   | 403  |
| `HORS_VERSION`           | Unsupported protocol version                                         | 400  |
| `HORS_FUNCTION_MISMATCH` | Signed function ≠ called function                                    | 403  |
| `HORS_ARGS_MISMATCH`     | Signed arguments hash ≠ received arguments                           | 403  |
| `HORS_BAD_SIGNATURE`     | Signature invalid for `address` on `chainId`                         | 403  |
| `HORS_REPLAY`            | Nonce or call ID already consumed                                    | 403  |
| `HORS_DENIED_WALLET`     | Address is on the deny list                                          | 403  |
| `HORS_NOT_HUMAN`         | Wallet is not registered in AgentBook                                | 403  |
| `HORS_ORIGIN_MISMATCH`   | No origin member matched                                             | 403  |
| `HORS_RULE_DENIED`       | A rule returned `false` or a deny object without a custom code       | 403  |
| `HORS_POLICY_ERROR`      | Policy code threw or timed out; or no policy exists for the tool     | 500  |
| `HORS_LOCAL_DISABLED`    | Local call while `local: "deny"`                                     | 403  |
| `HORS_OWNER_UNRESOLVED`  | Remote `same-human` while the service has no owner yet               | 503  |
| `HORS_UNAVAILABLE`       | AgentBook RPC, signature RPC or store unavailable; fail closed       | 503  |

Custom codes from rules use `403`. SDK errors are `HorsError { code, message, data? }`
with the codes above plus `CONFIG_INVALID`, `PROFILE_NOT_FOUND`, `RESOLVER_FAILED` and
`REGISTRATION_FAILED`. Reasons never contain internal exception text.

## Calling gated services (`hors-sdk/client`)

```ts
import { createSigner } from "hors-sdk/client";

const signer = await createSigner({ profile: "alice" });
const outcome = await signer.call("work", "approve", { amount: 1 });
if (!outcome.ok) console.log(outcome.code, outcome.reason, outcome.challenge);
```

```ts
interface SignerOptions {
  profile?: string;                    // <HORS_HOME>/<profile>; default HORS_PROFILE ?? "default"
  account?: Account;                   // viem account; bypasses the key file
  chainId?: ChainId;                   // default "eip155:480" (World Chain)
  meta?: Record<string, unknown> | ((call: CallInfo) => Record<string, unknown> | Promise<Record<string, unknown>>);
  expirySeconds?: number;              // default 120; 1..3600
  services?: Record<string, string>;   // address book layer over <HORS_HOME>/services.json
  rpc?: { ens?: string; signatures?: Record<string, string> };
  cache?: false | { home?: string };   // resolver cache; false for runtimes without a filesystem
  fetch?: typeof fetch;
}
interface Signer {
  readonly address: Address;
  readonly humanId: HumanId | null;    // the pin, not a live lookup
  sign(call: { url: string; fn: string; argsHash: string }): Promise<Envelope>;
  wrapTransport(transport: Transport, opts: { url: string; meta? }): Transport;  // MCP: signs every tools/call
  fetch(input, init?: RequestInit & { meta? }): Promise<Response>;               // HTTP: HORS-Authorization header
  call(service, fn, args, opts?: { meta?; refresh?; signal?: AbortSignal }): Promise<CallOutcome>;
}
type CallOutcome =
  | { ok: true; result: CallToolResult; hors: HorsResultMeta | null }   // null: the server is not horsed
  | { ok: false; code: string; reason: string; challenge: unknown; hors: HorsResultMeta };
```

- `call()` resolves `service` (address-book name, URL, `ens:`/`.eth` name or `erc8004:` URI),
  connects a Streamable HTTP client whose transport is wrapped by `wrapTransport`, calls,
  and closes. A denial is returned, not thrown, so agents can act on challenges. A tool
  result with `isError` but no HORS denial is the tool's own error (`ok: true`).
- `wrapTransport` signs only `tools/call`; `url` must be the endpoint the transport posts to.
- `fetch()` buffers the body, hashes the bytes, signs `<METHOD> <path>` and sends the same
  bytes. Denials come back as ordinary responses; `readResult(response)` decodes `HORS-Result`.
- A silent server is bounded by the MCP client's 60 s request timeout (`HORS_UNAVAILABLE`);
  pass `signal` for a shorter bound.
- `hors-sdk/client` with `account` reads no files and runs on any runtime; the MCP client
  and the resolvers are loaded on demand.

## Resolvers and address book (`hors-sdk/resolvers`)

A `service` string is interpreted in this order: an address-book name; a URL; a resolver
URI; a bare ENS name. The address book is `services` in config over `<HORS_HOME>/services.json`.

| Form                        | Resolution                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `https://…`                 | Used as is; credentials in the URL are refused.                                              |
| `ens:<name>` / `<name>.eth` | ENSIP-26 text record `agent-endpoint[mcp]` via `rpc.ens`; must be an `https:` URL.            |
| `erc8004:eip155:<n>/<id>`   | ERC-8004 Identity Registry `tokenURI`, then the registration file's `MCP` service endpoint.   |

```ts
import { resolve, classifyService } from "hors-sdk/resolvers";
const url = await resolve("finance.alice.eth", { rpc: { ens: "https://…" } });
classifyService("erc8004:eip155:1/42");   // "url" | "ens" | "erc8004" | undefined
```

Resolver results are cached for one hour in `<home>/cache/resolve.json` (`refresh: true`
bypasses; `cache: false` disables the filesystem entirely). To publish an MCP endpoint
under an ENS name, set the text record `agent-endpoint[mcp]` in the ENS manager app (or
`setText` on the name's resolver from `registry.resolver(node)`). Resolution never implies
trust: it only tells you where the name points.

## Node helpers (`hors-sdk/node`) and AgentBook (`hors-sdk/world`)

`hors-sdk/node` is the filesystem side used by the CLI: `profileHome(env)`,
`readProfile` / `createProfile` / `writeProfile` / `deleteProfile`, `readKeyFile`,
`readAddressBook` / `writeAddressBook`, `PROFILE_NAME`, and `loadConfig({ cwd?, env?, configFile? })`,
which performs the same discovery and validation as `createGate` and reports the file it
used. Profile names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; keys are written `0600`
with an exclusive create and never appear in records, errors or logs.

`hors-sdk/world` exposes `createAgentBook({ rpcUrl, cache? })` (cached `lookupHuman`) and
`MockAgentBook`, the deterministic registry of development mode.

## Audit and logging

Every evaluation emits one frozen `AuditEvent`
`{ v, at, fn, callId, transport, local, callerAddress, callerHumanId, status, code?, policy?, durationMs }`
— never arguments, results or `meta`. Denials are logged at `info`, successes at `debug`;
`gate.on("audit", listener)` adds a listener and returns an unsubscribe function. Logs are
one JSON object per line (`t`, `level`, `msg`, `data`); `HORS_LOG` sets the level.

## Development mode

`HORS_MOCK=1` (or `dev.mockOrigin: true`) replaces AgentBook with a deterministic mock:
every wallet is its own fake human (`keccak256("hors-mock" + address)`), so the same wallet
on both sides is `same-human` and a second wallet is another human. Signatures are still
real and verified; only the registry is mocked. Put it on the **service**; the CLI needs it
only for `hors whoami`/`status` to print the mock identity. The gate logs a warning at
start, `hors/result` carries `"mock": true`, and construction throws under
`NODE_ENV=production`. `hors connect --profile <p> --no-register` creates wallets without
World App for this loop.

## Deployment

- One `createGate()` per process; share it with the MCP factory or the HTTP guard.
- Behind a reverse proxy: preserve `Host`, or list the public URL(s) in `origins`, or set
  `trustProxy: true` and forward `X-Forwarded-Host`. Never set `trustProxy` without a
  proxy in front — a client could then choose the expected host. Tunnels that forward
  `Host` (ngrok) need no `origins`.
- Use your own World Chain RPC in production (`rpc.worldchain`); the public default is
  rate-limited and shared.
- More than one replica: provide a shared `store` with an atomic `consumeOnce`.
- Servers without a profile directory: `HORS_PRIVATE_KEY` plus `HORS_OWNER` (from
  `hors whoami` on the human's machine).
- Runtimes: Node ≥ 22.18 for the gate and CLI; `hors-sdk/client` with `account` and
  `hors-sdk/http` `handle()` run on any fetch-standard runtime.
