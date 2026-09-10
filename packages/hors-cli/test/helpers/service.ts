import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type AuditEvent, createGate, hashArgs } from "hors-sdk";
import { hors } from "hors-sdk/mcp";
import { generatePrivateKey } from "viem/accounts";
import { z } from "zod";

const echoSchema = z.record(z.string(), z.unknown());

export interface TestService {
  readonly url: string;
  readonly audits: AuditEvent[];
  readonly incoming: Request[];
  readonly fetch: typeof fetch;
  lastArgsHash?: string;
  close(): Promise<void>;
}

export async function startService(): Promise<TestService> {
  const audits: AuditEvent[] = [];
  const incoming: Request[] = [];
  const key = generatePrivateKey();
  const serviceHome = await mkdtemp(join(tmpdir(), "hors-svc-"));
  const prevHome = process.env.HORS_HOME;
  const prevKey = process.env.HORS_PRIVATE_KEY;
  process.env.HORS_PRIVATE_KEY = key;
  process.env.HORS_HOME = serviceHome;
  let lastArgsHash: string | undefined;
  const gate = await createGate({
    policy: "any-human",
    functions: {
      echo: "any-human",
      deny: {
        origin: "any-human",
        rule: () => ({ deny: "nope", challenge: { ask: "human" } }),
      },
    },
    dev: { mockOrigin: true },
    configFile: false,
  });
  if (prevHome === undefined) {
    delete process.env.HORS_HOME;
  } else {
    process.env.HORS_HOME = prevHome;
  }
  if (prevKey === undefined) {
    delete process.env.HORS_PRIVATE_KEY;
  } else {
    process.env.HORS_PRIVATE_KEY = prevKey;
  }
  gate.on("audit", (event) => {
    audits.push(event);
  });

  const handler = createMcpHandler(async () => {
    const raw = new McpServer({ name: "hors-cli-test", version: "1.0.0" });
    const gated = await hors(raw, { gate, transport: "http" });
    gated.registerTool(
      "echo",
      { description: "echo args", inputSchema: echoSchema, hors: "any-human" },
      (args, ctx) => {
        lastArgsHash = ctx.hors.argsHash;
        return { content: [{ type: "text", text: JSON.stringify(args) }] };
      },
    );
    gated.registerTool("paint", { description: "return ANSI text", hors: "any-human" }, () => ({
      content: [{ type: "text", text: "\u001b[31mred" }],
    }));
    gated.registerTool("wrap", { description: "line1\nline2\ttab", hors: "public" }, () => ({
      content: [{ type: "text", text: "wrap" }],
    }));
    gated.registerTool(
      "deny",
      {
        description: "always denied",
        hors: {
          origin: "any-human",
          rule: () => ({ deny: "nope", challenge: { ask: "human" } }),
        },
      },
      () => ({ content: [] }),
    );
    return raw;
  });

  const server = await listen(async (request) => {
    incoming.push(request);
    return handler.fetch(request);
  });
  const url = `http://127.0.0.1:${portOf(server)}/mcp`;
  const fetchImpl: typeof fetch = (input, init) => handler.fetch(new Request(input, init));
  const service: TestService = {
    url,
    audits,
    incoming,
    fetch: fetchImpl,
    get lastArgsHash() {
      return lastArgsHash;
    },
    set lastArgsHash(value) {
      lastArgsHash = value;
    },
    async close() {
      await closeServer(server);
      await rm(serviceHome, { recursive: true, force: true });
    },
  };
  return service;
}

function portOf(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("not listening");
  }
  return addr.port;
}

async function listen(fetchImpl: (request: Request) => Promise<Response>): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? "127.0.0.1";
      const url = `http://${host}${req.url ?? "/"}`;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(name, value);
        } else if (Array.isArray(value)) {
          headers.set(name, value.join(", "));
        }
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: body.length === 0 || req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await fetchImpl(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        res.setHeader(name, value);
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export { Client, hashArgs, StreamableHTTPClientTransport };
