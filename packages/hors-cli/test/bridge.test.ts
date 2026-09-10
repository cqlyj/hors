import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { hashArgs } from "hors-sdk";
import { writeAddressBook } from "hors-sdk/node";
import { MockAgentBook } from "hors-sdk/world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DESCRIPTIONS } from "../src/bridge/schemas.js";
import { createBridge } from "../src/index.js";
import { HUMAN_B, overrideBook, pinProfile } from "./helpers/profile.js";
import { startService, type TestService } from "./helpers/service.js";
import { withTempDir } from "./helpers/tmp.js";

async function paired(deps: Parameters<typeof createBridge>[0]) {
  const server = createBridge(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "hors-cli-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    logs: [] as string[],
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content?: unknown; isError?: boolean; structuredContent?: unknown }) {
  const item = Array.isArray(result.content) ? result.content[0] : undefined;
  const text =
    item !== undefined &&
    typeof item === "object" &&
    item !== null &&
    "text" in item &&
    typeof item.text === "string"
      ? item.text
      : "";
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { text, parsed, result };
}

describe("hors mcp bridge (T8)", () => {
  let service: TestService;
  beforeAll(async () => {
    service = await startService();
  });
  afterAll(async () => {
    await service.close();
  });

  it("exposes exactly the five bridge tools", async () => {
    await withTempDir(async (home) => {
      const logs: string[] = [];
      const pair = await paired({
        home,
        profile: "default",
        env: {},
        log: (line) => logs.push(line),
      });
      const listed = await pair.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "hors_add_service",
        "hors_call",
        "hors_list",
        "hors_services",
        "hors_status",
      ]);
      const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
      expect(byName.hors_call?.description).toMatch(/hors_list/);
      expect(byName.hors_call?.description).toMatch(/denied/);
      expect(byName.hors_call?.description).toMatch(/human/);
      expect(byName.hors_status?.description).toMatch(/hint/);
      expect(JSON.stringify(listed.tools)).not.toMatch(/private key|key file/i);
      expect(DESCRIPTIONS.hors_call).toMatch(/hors_list/);
      await pair.close();
    });
  });

  it("reports not connected, connected, hijacked, and RPC failure", async () => {
    await withTempDir(async (home) => {
      const logs: string[] = [];
      const disconnected = await paired({
        home,
        profile: "default",
        env: {},
        log: (line) => logs.push(line),
      });
      const raw = textOf(
        await disconnected.client.callTool({ name: "hors_status", arguments: {} }),
      );
      expect(raw.parsed).toMatchObject({
        connected: false,
        hint: "Run npx -y hors-cli connect --profile default in a visible terminal and scan the World App QR.",
      });
      await disconnected.close();

      const record = await pinProfile(home);
      const ok = await paired({
        home,
        profile: "default",
        env: {},
        agentBook: new MockAgentBook(),
        log: () => undefined,
      });
      const connected = textOf(await ok.client.callTool({ name: "hors_status", arguments: {} }));
      expect(connected.parsed).toMatchObject({ connected: true, hint: null });
      await ok.close();

      const hijackBook = overrideBook([[record.address, HUMAN_B]]);
      const hijacked = await paired({
        home,
        profile: "default",
        env: {},
        agentBook: hijackBook,
        log: () => undefined,
      });
      const hijack = textOf(await hijacked.client.callTool({ name: "hors_status", arguments: {} }));
      expect(hijack.parsed).toMatchObject({ connected: false });
      expect(JSON.stringify(hijack.parsed)).toMatch(/re-register/);
      await hijacked.close();

      const rpc = await paired({
        home,
        profile: "default",
        env: {},
        agentBook: {
          lookupHuman: async () => {
            throw new Error("econnrefused");
          },
          getNextNonce: async () => 1n,
        },
        log: () => undefined,
      });
      const down = textOf(await rpc.client.callTool({ name: "hors_status", arguments: {} }));
      expect(down.parsed).toMatchObject({ connected: true });
      expect(JSON.stringify(down.parsed)).toMatch(/RPC/);
      await rpc.close();
    });
  });

  it("reports connected mock identity without a live lookup when HORS_MOCK=1", async () => {
    await withTempDir(async (home) => {
      const { createProfile } = await import("hors-sdk/node");
      const record = await createProfile(home, "default");
      let looked = 0;
      const pair = await paired({
        home,
        profile: "default",
        env: { HORS_MOCK: "1" },
        agentBook: {
          lookupHuman: async () => {
            looked += 1;
            return HUMAN_B;
          },
          getNextNonce: async () => 1n,
        },
        log: () => undefined,
      });
      const status = textOf(await pair.client.callTool({ name: "hors_status", arguments: {} }));
      expect(status.parsed).toEqual({
        connected: true,
        address: record.address,
        humanId: MockAgentBook.humanIdOf(record.address),
        profile: "default",
        hint: null,
        mock: true,
      });
      expect(looked).toBe(0);
      await pair.close();
    });
  });

  it("round-trips the address book and rejects a bad URI", async () => {
    await withTempDir(async (home) => {
      const pair = await paired({ home, profile: "default", env: {}, log: () => undefined });
      const added = textOf(
        await pair.client.callTool({
          name: "hors_add_service",
          arguments: { name: "work", uri: "https://work.example.com/mcp" },
        }),
      );
      expect(added.parsed).toEqual({ name: "work", uri: "https://work.example.com/mcp" });
      const listed = textOf(await pair.client.callTool({ name: "hors_services", arguments: {} }));
      expect(listed.parsed).toEqual([{ name: "work", uri: "https://work.example.com/mcp" }]);
      const bad = await pair.client.callTool({
        name: "hors_add_service",
        arguments: { name: "x", uri: "ftp://nope" },
      });
      expect(bad.isError).toBe(true);
      await pair.close();
    });
  });

  it("resolves hors_call from --home services.json, not HORS_HOME", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (other) => {
        await pinProfile(home);
        await writeAddressBook(home, { work: "https://work.example.com/mcp" });
        const pair = await paired({
          home,
          profile: "default",
          env: { HORS_HOME: other },
          fetch: service.fetch,
          agentBook: new MockAgentBook(),
          log: () => undefined,
        });
        const called = await pair.client.callTool({
          name: "hors_call",
          arguments: { service: "work", fn: "echo", args: { n: 1 } },
        });
        expect(called.isError).not.toBe(true);
        await pair.close();
      });
    });
  });

  it("lists and calls a loopback service, forwarding args byte-exact", async () => {
    await withTempDir(async (home) => {
      await pinProfile(home);
      await writeAddressBook(home, { work: "https://work.example.com/mcp" });
      const pair = await paired({
        home,
        profile: "default",
        env: {},
        fetch: service.fetch,
        agentBook: new MockAgentBook(),
        log: () => undefined,
      });
      const listed = textOf(
        await pair.client.callTool({ name: "hors_list", arguments: { service: "work" } }),
      );
      expect(Array.isArray(listed.parsed)).toBe(true);
      const args = { b: 2, a: 1 };
      const called = await pair.client.callTool({
        name: "hors_call",
        arguments: { service: "work", fn: "echo", args },
      });
      expect(called.isError).not.toBe(true);
      expect(called._meta?.["hors/result"]).toMatchObject({ status: "ok" });
      expect(service.lastArgsHash).toBe(await hashArgs(args));

      const denied = await pair.client.callTool({
        name: "hors_call",
        arguments: { service: "work", fn: "deny", args: {} },
      });
      expect(denied.isError).toBeFalsy();
      const body = textOf(denied);
      expect(body.parsed).toMatchObject({
        denied: true,
        code: "HORS_RULE_DENIED",
        challenge: { ask: "human" },
      });

      const unknown = await pair.client.callTool({
        name: "hors_call",
        arguments: { service: "missing", fn: "echo" },
      });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown).text.startsWith("RESOLVER_FAILED:")).toBe(true);
      await pair.close();
    });
  });

  it("errors when hors_call is used without a connected profile", async () => {
    await withTempDir(async (home) => {
      const pair = await paired({ home, profile: "default", env: {}, log: () => undefined });
      const result = await pair.client.callTool({
        name: "hors_call",
        arguments: { service: "work", fn: "echo" },
      });
      expect(result.isError).toBe(true);
      const item = Array.isArray(result.content) ? result.content[0] : undefined;
      const text =
        item !== undefined &&
        typeof item === "object" &&
        item !== null &&
        "text" in item &&
        typeof item.text === "string"
          ? item.text
          : "";
      expect(text).toMatch(/hors-cli connect/);
      await pair.close();
    });
  });

  it("honours hors.config.ts services over the address book and uses rpc.worldchain", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (cwd) => {
        await pinProfile(home);
        await writeAddressBook(home, { work: "https://from-book.example/mcp" });
        await writeFile(
          join(cwd, "hors.config.json"),
          JSON.stringify({
            services: { work: "https://from-config.example/mcp" },
            rpc: { worldchain: "http://127.0.0.1:1" },
          }),
        );
        const seen: string[] = [];
        const fetchImpl: typeof fetch = (input, init) => {
          seen.push(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          return service.fetch(input, init);
        };
        const pair = await paired({
          home,
          profile: "default",
          env: {},
          cwd,
          fetch: fetchImpl,
          agentBook: new MockAgentBook(),
          log: () => undefined,
        });
        const listed = textOf(
          await pair.client.callTool({ name: "hors_list", arguments: { service: "work" } }),
        );
        expect(Array.isArray(listed.parsed)).toBe(true);
        expect(seen.some((url) => url.includes("from-config.example"))).toBe(true);
        expect(seen.some((url) => url.includes("from-book.example"))).toBe(false);
        seen.length = 0;
        const called = await pair.client.callTool({
          name: "hors_call",
          arguments: { service: "work", fn: "echo", args: { n: 1 } },
        });
        expect(called.isError).not.toBe(true);
        expect(seen.some((url) => url.includes("from-config.example"))).toBe(true);
        await pair.close();

        const statusLogs: string[] = [];
        const rpc = await paired({
          home,
          profile: "default",
          env: {},
          cwd,
          log: (line) => statusLogs.push(line),
        });
        const down = textOf(await rpc.client.callTool({ name: "hors_status", arguments: {} }));
        expect(down.parsed).toMatchObject({ connected: true });
        expect(JSON.stringify(down.parsed)).toMatch(/RPC/);
        await rpc.close();
      });
    });
  });

  it("reports an invalid config on the log channel", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "hors.config.json"), '{"owner":"xyz"}');
        const logs: string[] = [];
        const pair = await paired({
          home,
          profile: "default",
          env: {},
          cwd,
          log: (line) => logs.push(line),
        });
        await pair.client.callTool({ name: "hors_status", arguments: {} });
        expect(logs.some((line) => line.includes("config invalid"))).toBe(true);
        await pair.close();
      });
    });
  });
});
