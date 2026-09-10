import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { type HorsConfig, validateConfig } from "../../src/config/schema.js";
import type { AuditEvent } from "../../src/gate/audit.js";
import { buildGate, type Gate } from "../../src/gate/gate.js";
import { hashArgs } from "../../src/hash.js";
import { type HorsMcpOptions, type HorsMcpServer, hors } from "../../src/mcp/index.js";
import { MockAgentBook } from "../../src/world/mock.js";
import { memoryLogger } from "./logger.js";
import { signedEnvelope } from "./sign.js";

const closers: Array<() => Promise<void>> = [];

export async function closeMcpPairs(): Promise<void> {
  const pending = closers.splice(0);
  await Promise.allSettled(pending.map((close) => close()));
}

export function trackMcpClose(close: () => Promise<void>): void {
  closers.push(close);
}

export async function testGate(
  home: string,
  config: HorsConfig = {},
): Promise<{
  gate: Gate;
  logs: ReturnType<typeof memoryLogger>["events"];
  audits: AuditEvent[];
  agentBook: MockAgentBook;
  account: PrivateKeyAccount;
}> {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const { log, events: logs } = memoryLogger();
  const audits: AuditEvent[] = [];
  const agentBook = new MockAgentBook();
  const gate = await buildGate(
    validateConfig({ dev: { mockOrigin: true }, ...config }, { nodeEnv: undefined }),
    { env: { HORS_HOME: home, HORS_PRIVATE_KEY: key }, log, agentBook },
  );
  gate.on("audit", (event) => {
    audits.push(event);
  });
  return { gate, logs, audits, agentBook, account };
}

async function resolveGate(
  home: string,
  opts?: HorsMcpOptions & { config?: HorsConfig },
): Promise<{
  gate: Gate;
  logs: ReturnType<typeof memoryLogger>["events"];
  audits: AuditEvent[];
  agentBook: MockAgentBook;
  account: PrivateKeyAccount;
}> {
  return opts?.gate
    ? {
        gate: opts.gate,
        logs: [] as ReturnType<typeof memoryLogger>["events"],
        audits: [] as AuditEvent[],
        agentBook: new MockAgentBook(),
        account: privateKeyToAccount(generatePrivateKey()),
      }
    : await testGate(home, opts?.config);
}

export async function linkedPair(
  home: string,
  opts?: HorsMcpOptions & {
    config?: HorsConfig;
    beforeHors?: (server: McpServer) => void;
    setup?: (server: HorsMcpServer) => void;
  },
): Promise<{
  client: Client;
  server: HorsMcpServer;
  raw: McpServer;
  gate: Gate;
  logs: ReturnType<typeof memoryLogger>["events"];
  audits: AuditEvent[];
  agentBook: MockAgentBook;
  account: PrivateKeyAccount;
}> {
  const { beforeHors, setup, config, ...horsOpts } = opts ?? {};
  const built = await resolveGate(home, { ...horsOpts, config });
  const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
  beforeHors?.(raw);
  const server = await hors(raw, { ...horsOpts, gate: built.gate });
  setup?.(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "hors-test-client", version: "1.0.0" });
  trackMcpClose(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, raw, ...built };
}

export async function httpPair(
  home: string,
  opts?: HorsMcpOptions & {
    config?: HorsConfig;
    endpoint?: string;
    headers?: Record<string, string>;
    beforeHors?: (server: McpServer) => void;
    setup: (server: HorsMcpServer) => void;
  },
): Promise<{
  client: Client;
  handler: ReturnType<typeof createMcpHandler>;
  gate: Gate;
  logs: ReturnType<typeof memoryLogger>["events"];
  audits: AuditEvent[];
  agentBook: MockAgentBook;
  account: PrivateKeyAccount;
}> {
  const { setup, config, endpoint, headers, beforeHors, ...horsOpts } = opts ?? {
    setup: () => undefined,
  };
  const built = await resolveGate(home, { ...horsOpts, config });
  const handler = createMcpHandler(async (): Promise<McpServer> => {
    const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
    beforeHors?.(raw);
    const server = await hors(raw, {
      ...horsOpts,
      gate: built.gate,
    });
    setup(server);
    return raw;
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(endpoint ?? "https://work.example.com/mcp"),
    {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
      requestInit: headers === undefined ? undefined : { headers },
    },
  );
  const client = new Client({ name: "hors-test-client", version: "1.0.0" });
  trackMcpClose(async () => {
    await client.close();
  });
  await client.connect(transport);
  return { client, handler, ...built };
}

export async function signedCall(
  client: Client,
  account: PrivateKeyAccount,
  name: string,
  args: Record<string, unknown>,
  options?: {
    meta?: unknown;
    tamperArgsHash?: string;
    fields?: Record<string, unknown>;
    now?: number;
  },
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const { raw } = await signedEnvelope(account, {
    fn: name,
    argsHash: options?.tamperArgsHash ?? (await hashArgs(args)),
    fields: options?.fields,
    now: options?.now,
  });
  return client.callTool({
    name,
    arguments: args,
    _meta: {
      "hors/auth": raw,
      ...(options?.meta === undefined ? {} : { "hors/meta": options.meta }),
    },
  });
}
