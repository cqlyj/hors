import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer, type RegisteredTool } from "@modelcontextprotocol/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateConfig } from "../src/config/schema.js";
import { HorsError } from "../src/errors.js";
import { buildGate } from "../src/gate/gate.js";
import { hashArgs } from "../src/hash.js";
import { hors } from "../src/mcp/index.js";
import type { HorsContext } from "../src/policy/types.js";
import { MockAgentBook } from "../src/world/mock.js";
import { HUMAN_A } from "./helpers/context.js";
import { memoryLogger } from "./helpers/logger.js";
import {
  closeMcpPairs,
  httpPair,
  linkedPair,
  signedCall,
  testGate,
  trackMcpClose,
} from "./helpers/mcp.js";
import { signedEnvelope } from "./helpers/sign.js";
import { withTempDir } from "./helpers/tmp.js";

const amountSchema = z.object({ amount: z.number() });

function resultMeta(value: { _meta?: Record<string, unknown> }): Record<string, unknown> {
  const meta = value._meta?.["hors/result"];
  expect(meta).toBeTypeOf("object");
  return meta as Record<string, unknown>;
}

afterEach(async () => {
  await closeMcpPairs();
});

describe("hors MCP adapter", () => {
  it("annotates tools/list, rejects unknown policies, and leaves failed registrations out (T1)", async () => {
    await withTempDir(async (home) => {
      const { client, server } = await linkedPair(home, {
        config: { functions: { b: "any-human" } },
        setup(next) {
          next.registerTool("a", { hors: "public" }, () => ({ content: [] }));
          next.registerTool("b", {}, () => ({ content: [] }));
          next.registerTool("c", { hors: { origin: HUMAN_A }, _meta: { x: 1 } }, () => ({
            content: [],
          }));
        },
      });
      const listed = await client.listTools();
      const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
      expect(byName.a?._meta?.["hors/policy"]).toEqual({
        v: 1,
        name: "public",
        origin: ["public"],
        custom: false,
      });
      expect(byName.b?._meta?.["hors/policy"]).toEqual({
        v: 1,
        name: "any-human",
        origin: ["any-human"],
        custom: false,
      });
      expect(byName.c?._meta).toEqual({
        x: 1,
        "hors/policy": { v: 1, origin: ["human"], custom: false },
      });
      expect(listed.tools.every((tool) => !("hors" in tool))).toBe(true);

      expect(() =>
        server.registerTool("d", { hors: "no-such" }, () => ({ content: [] })),
      ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("d");

      expect(() => server.registerTool("a", { hors: "public" }, () => ({ content: [] }))).toThrow();
      const again = await client.callTool({ name: "a", arguments: {} });
      expect(again.isError).not.toBe(true);
      expect(resultMeta(again).status).toBe("ok");
    });
  });

  it("treats in-memory calls as local and preserves handler arity (T2)", async () => {
    await withTempDir(async (home) => {
      let seen: HorsContext | undefined;
      let arity = 0;
      let publicArgs = 0;
      const { client, gate } = await linkedPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, (args, ctx) => {
            arity = 2;
            seen = ctx.hors;
            expect(ctx.hors.request === ctx).toBe(true);
            expect("callerHumanId" in ctx).toBe(false);
            expect(args).toEqual({ amount: 1 });
            return { content: [{ type: "text", text: "ran" }] };
          });
          server.registerTool("open", { hors: "public" }, (ctx) => {
            publicArgs = 1;
            expect(ctx.hors.fn).toBe("open");
            expect(ctx).toBeDefined();
            return { content: [{ type: "text", text: "open" }] };
          });
        },
      });

      const ok = await client.callTool({ name: "same", arguments: { amount: 1 } });
      expect(ok.content).toEqual([{ type: "text", text: "ran" }]);
      expect(resultMeta(ok)).toEqual({
        v: 1,
        status: "ok",
        policy: "same-human",
        local: true,
        mock: true,
      });
      expect(seen?.local).toBe(true);
      expect(seen?.transport).toBe("mcp-stdio");
      expect(seen?.callerHumanId).toBe(gate.owner());
      expect(arity).toBe(2);

      const open = await client.callTool({ name: "open", arguments: {} });
      expect(open.isError).not.toBe(true);
      expect(publicArgs).toBe(1);

      const handler = vi.fn(() => ({ content: [{ type: "text" as const, text: "no" }] }));
      const deniedPair = await linkedPair(home, {
        config: { local: "deny" },
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, handler);
        },
      });
      const denied = await deniedPair.client.callTool({ name: "same", arguments: { amount: 1 } });
      expect(denied).toEqual({
        isError: true,
        content: [{ type: "text", text: "HORS_LOCAL_DISABLED: local calls are disabled" }],
        _meta: {
          "hors/result": {
            v: 1,
            status: "deny",
            code: "HORS_LOCAL_DISABLED",
            reason: "local calls are disabled",
            policy: "same-human",
            challenge: null,
            local: true,
            mock: true,
          },
        },
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("refuses an unsigned HTTP tools/call (T3 unsigned)", async () => {
    await withTempDir(async (home) => {
      const { client } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({
            content: [],
          }));
        },
      });
      const unsigned = await client.callTool({
        name: "same",
        arguments: { amount: 1, stray: 2 },
      });
      expect(resultMeta(unsigned)).toMatchObject({
        status: "deny",
        code: "HORS_UNSIGNED",
        local: false,
      });
    });
  });

  it("hashes raw arguments and hands coerced args to the handler (T3 signed/raw)", async () => {
    await withTempDir(async (home) => {
      const { client, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, (args, ctx) => {
            expect(args).toEqual({ amount: 1 });
            expect(ctx.hors.args).toEqual({ amount: 1, stray: 2 });
            expect(ctx.hors.transport).toBe("mcp-http");
            return { content: [{ type: "text", text: "ok" }] };
          });
        },
      });
      const signed = await signedCall(client, account, "same", { amount: 1, stray: 2 });
      expect(signed.isError).not.toBe(true);
      expect(resultMeta(signed).status).toBe("ok");
    });
  });

  it("denies when the envelope args hash does not match the raw arguments (T3 args hash)", async () => {
    await withTempDir(async (home) => {
      const { client, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({ content: [] }));
        },
      });
      const mismatch = await signedCall(
        client,
        account,
        "same",
        { amount: 1, stray: 2 },
        {
          tamperArgsHash: await hashArgs({ amount: 1 }),
        },
      );
      expect(resultMeta(mismatch).code).toBe("HORS_ARGS_MISMATCH");
    });
  });

  it("denies a signed call from another human (T3 outsider)", async () => {
    await withTempDir(async (home) => {
      const { client } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({ content: [] }));
        },
      });
      const other = privateKeyToAccount(generatePrivateKey());
      const outsider = await signedCall(client, other, "same", { amount: 1, stray: 2 });
      expect(resultMeta(outsider).code).toBe("HORS_ORIGIN_MISMATCH");
    });
  });

  it("rejects oversized hors/meta before identity lookup (T3 oversize meta)", async () => {
    await withTempDir(async (home) => {
      const { client, account, agentBook } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({ content: [] }));
        },
      });
      const lookup = vi.spyOn(agentBook, "lookupHuman");
      const huge = await signedCall(
        client,
        account,
        "same",
        { amount: 1, stray: 2 },
        {
          meta: { k: "a".repeat(70_000) },
        },
      );
      expect(resultMeta(huge).code).toBe("HORS_BAD_ENVELOPE");
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  it("consumes a replayed envelope and records HTTP audits (T3 replay)", async () => {
    await withTempDir(async (home) => {
      const { client, account, audits, gate } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({
            content: [{ type: "text", text: "ok" }],
          }));
        },
      });
      const args = { amount: 1, stray: 2 };
      const { raw } = await signedEnvelope(account, {
        fn: "same",
        argsHash: await hashArgs(args),
      });
      await client.callTool({ name: "same", arguments: args, _meta: { "hors/auth": raw } });
      const replayed = await client.callTool({
        name: "same",
        arguments: args,
        _meta: { "hors/auth": raw },
      });
      expect(resultMeta(replayed).code).toBe("HORS_REPLAY");
      expect(audits.every((event) => event.transport === "mcp-http")).toBe(true);
      expect(audits).toHaveLength(2);
      expect(gate.mock).toBe(true);
    });
  });

  it("uses X-Forwarded-Host when trustProxy is set (T3 trustProxy)", async () => {
    await withTempDir(async (home) => {
      const forwarded = await httpPair(home, {
        config: { trustProxy: true },
        headers: { "x-forwarded-host": "edge.example.com" },
        setup(server) {
          server.registerTool("same", { hors: "public", inputSchema: amountSchema }, () => ({
            content: [{ type: "text", text: "edge" }],
          }));
        },
      });
      const edgeOk = await signedCall(
        forwarded.client,
        forwarded.account,
        "same",
        { amount: 1 },
        {
          fields: { domain: "edge.example.com", uri: "https://edge.example.com/mcp" },
        },
      );
      expect(resultMeta(edgeOk).status).toBe("ok");
    });
  });

  it("ignores X-Forwarded-Host when trustProxy is unset (T3 untrusted forwarded)", async () => {
    await withTempDir(async (home) => {
      const untrusted = await httpPair(home, {
        headers: { "x-forwarded-host": "edge.example.com" },
        setup(server) {
          server.registerTool("same", { hors: "public", inputSchema: amountSchema }, () => ({
            content: [],
          }));
        },
      });
      const edgeDenied = await signedCall(
        untrusted.client,
        untrusted.account,
        "same",
        { amount: 1 },
        { fields: { domain: "edge.example.com", uri: "https://edge.example.com/mcp" } },
      );
      expect(resultMeta(edgeDenied).code).toBe("HORS_DOMAIN_MISMATCH");
      expect(
        String(
          edgeDenied.content[0] && "text" in edgeDenied.content[0]
            ? edgeDenied.content[0].text
            : "",
        ),
      ).toContain("work.example.com");
    });
  });

  it("strips the query from the expected URL (T3 query stripped)", async () => {
    await withTempDir(async (home) => {
      const queried = await httpPair(home, {
        endpoint: "https://work.example.com/mcp?x=1",
        setup(server) {
          server.registerTool("same", { hors: "public", inputSchema: amountSchema }, () => ({
            content: [{ type: "text", text: "q" }],
          }));
        },
      });
      const queryOk = await signedCall(queried.client, queried.account, "same", { amount: 1 });
      expect(resultMeta(queryOk).status).toBe("ok");
    });
  });

  it("refuses tools registered outside hors() without auditing (T4)", async () => {
    await withTempDir(async (home) => {
      const early = vi.fn(() => ({ content: [{ type: "text" as const, text: "early" }] }));
      const { client, logs, audits } = await linkedPair(home, {
        beforeHors(server) {
          server.registerTool("early", {}, early);
        },
      });
      const denied = await client.callTool({ name: "early", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(resultMeta(denied)).toMatchObject({
        code: "HORS_POLICY_ERROR",
        reason: "no HORS policy is registered for this tool",
        policy: null,
        local: true,
        mock: true,
      });
      expect(early).not.toHaveBeenCalled();
      expect(
        logs.filter((event) => event.level === "error" && event.data?.fn === "early"),
      ).toHaveLength(1);
      expect(audits).toEqual([]);

      const missing = await client.callTool({ name: "nonexistent", arguments: {} });
      expect(resultMeta(missing)).toMatchObject({
        code: "HORS_POLICY_ERROR",
        reason: "no HORS policy is registered for this tool",
        policy: null,
      });
    });
  });

  it("answers the seam-2 reason on the proxy JSON-RPC path (T4)", async () => {
    await withTempDir(async (home) => {
      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      raw.registerTool("early", {}, () => ({ content: [{ type: "text", text: "early" }] }));
      const server = await hors(raw, { gate: built.gate });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      trackMcpClose(async () => {
        await clientTransport.close();
        await server.close();
      });
      await server.connect(serverTransport);
      await clientTransport.start();
      const sendCall = async (name: string, id: number) => {
        const answered = new Promise<unknown>((resolve) => {
          clientTransport.onmessage = (message) => {
            resolve(message);
          };
        });
        await clientTransport.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: {} },
        });
        return answered;
      };
      const expected = {
        result: {
          isError: true,
          _meta: {
            "hors/result": {
              code: "HORS_POLICY_ERROR",
              reason: "no HORS policy is registered for this tool",
            },
          },
        },
      };
      expect(await sendCall("early", 7)).toMatchObject(expected);
      expect(await sendCall("nonexistent", 8)).toMatchObject(expected);
    });
  });

  it("does not treat a non-string tools/call name as a seam-2 denial (T4)", async () => {
    await withTempDir(async (home) => {
      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      const server = await hors(raw, { gate: built.gate });
      server.registerTool("ok", { hors: "public" }, () => ({ content: [] }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      trackMcpClose(async () => {
        await clientTransport.close();
        await server.close();
      });
      await server.connect(serverTransport);
      await clientTransport.start();
      const answered = new Promise<unknown>((resolve) => {
        clientTransport.onmessage = (message) => {
          resolve(message);
        };
      });
      await clientTransport.send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: 1 },
      });
      const reply = await answered;
      expect(reply).not.toMatchObject({
        result: { _meta: { "hors/result": { code: "HORS_POLICY_ERROR" } } },
      });
      expect(built.logs.some((event) => String(event.message).includes("hors mcp"))).toBe(false);
    });
  });

  it("re-wraps RegisteredTool.update (T5)", async () => {
    await withTempDir(async (home) => {
      const h1 = vi.fn(() => ({ content: [{ type: "text" as const, text: "h1" }] }));
      const h2 = vi.fn(() => ({ content: [{ type: "text" as const, text: "h2" }] }));
      let t: RegisteredTool | undefined;
      let w: RegisteredTool | undefined;
      const { client, account } = await linkedPair(home, {
        transport: "http",
        config: { origins: ["https://work.example.com/mcp"] },
        setup(server) {
          t = server.registerTool("u", { hors: "same-human", inputSchema: amountSchema }, h1);
          w = server.registerTool("w", { hors: "public" }, () => ({
            content: [{ type: "text", text: "w" }],
          }));
        },
      });
      if (t === undefined || w === undefined) {
        expect.unreachable();
      }

      const unsigned = await client.callTool({ name: "u", arguments: { amount: 1 } });
      expect(resultMeta(unsigned).code).toBe("HORS_UNSIGNED");
      t.update({ callback: h2 });
      expect(resultMeta(await client.callTool({ name: "u", arguments: { amount: 1 } })).code).toBe(
        "HORS_UNSIGNED",
      );
      const swapped = await signedCall(client, account, "u", { amount: 1 });
      expect(swapped.content).toEqual([{ type: "text", text: "h2" }]);
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledOnce();

      t.update({ _meta: { y: 2 } });
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === "u")?._meta).toEqual({
        y: 2,
        "hors/policy": { v: 1, name: "same-human", origin: ["same-human"], custom: false },
      });

      t.update({ name: "v" });
      expect(resultMeta(await signedCall(client, account, "v", { amount: 1 })).status).toBe("ok");
      expect(resultMeta(await client.callTool({ name: "u", arguments: { amount: 1 } })).code).toBe(
        "HORS_POLICY_ERROR",
      );

      t.remove();
      expect(resultMeta(await client.callTool({ name: "v", arguments: { amount: 1 } })).code).toBe(
        "HORS_POLICY_ERROR",
      );

      w.disable();
      await expect(client.callTool({ name: "w", arguments: {} })).rejects.toSatisfy((error) => {
        expect(String(error)).toContain("disabled");
        expect(error).not.toMatchObject({ code: "HORS_POLICY_ERROR" });
        return true;
      });
      w.enable();
      const enabled = await client.callTool({ name: "w", arguments: {} });
      expect(enabled.isError).not.toBe(true);
      expect(resultMeta(enabled).status).toBe("ok");
    });
  });

  it("republishes functions[newName] when renaming a tool with no inline policy", async () => {
    await withTempDir(async (home) => {
      let t: RegisteredTool | undefined;
      const { client } = await linkedPair(home, {
        config: { functions: { renamed: "public" } },
        setup(server) {
          t = server.registerTool("old", {}, () => ({ content: [{ type: "text", text: "ok" }] }));
        },
      });
      if (t === undefined) {
        expect.unreachable();
      }
      t.update({ name: "renamed" });
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === "renamed")?._meta?.["hors/policy"]).toEqual({
        v: 1,
        name: "public",
        origin: ["public"],
        custom: false,
      });
    });
  });

  it("leaves the registry unchanged when a rename onto an existing name throws", async () => {
    await withTempDir(async (home) => {
      let a: RegisteredTool | undefined;
      const { client } = await linkedPair(home, {
        setup(server) {
          a = server.registerTool("a", { hors: "public" }, () => ({
            content: [{ type: "text", text: "a" }],
          }));
          server.registerTool("b", { hors: "public" }, () => ({
            content: [{ type: "text", text: "b" }],
          }));
        },
      });
      if (a === undefined) {
        expect.unreachable();
      }
      const tool = a;
      expect(() => tool.update({ name: "b" })).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["a", "b"]);
      const stillA = await client.callTool({ name: "a", arguments: {} });
      expect(stillA.content).toEqual([{ type: "text", text: "a" }]);
    });
  });

  it("stamps successes and surfaces handler exceptions as the SDK's (T6)", async () => {
    await withTempDir(async (home) => {
      const { client, audits } = await linkedPair(home, {
        setup(server) {
          server.registerTool("boom", { hors: "public" }, () => {
            throw new Error("boom");
          });
          server.registerTool("undef", { hors: "public" }, () => {
            throw undefined;
          });
          server.registerTool("own", { hors: "public" }, () => ({
            content: [],
            _meta: { own: 1 },
          }));
          server.registerTool(
            "structured",
            { hors: "public", outputSchema: z.object({ ok: z.boolean() }) },
            () => ({
              content: [{ type: "text", text: "ok" }],
              structuredContent: { ok: true },
            }),
          );
          server.registerTool(
            "paid",
            {
              hors: {
                origin: "public",
                use: async (ctx) =>
                  ctx.deny("pay", { code: "OVER_BUDGET", challenge: { price: 1 } }),
              },
            },
            () => ({ content: [] }),
          );
        },
      });

      const boom = await client.callTool({ name: "boom", arguments: {} });
      expect(boom.isError).toBe(true);
      expect(boom._meta?.["hors/result"]).toBeUndefined();
      expect(audits.filter((event) => event.fn === "boom")).toEqual([
        expect.objectContaining({ status: "ok" }),
      ]);

      const undef = await client.callTool({ name: "undef", arguments: {} });
      expect(undef.isError).toBe(true);
      expect(undef._meta?.["hors/result"]).toBeUndefined();
      expect(audits.filter((event) => event.fn === "undef")).toEqual([
        expect.objectContaining({ status: "ok" }),
      ]);

      const own = await client.callTool({ name: "own", arguments: {} });
      expect(own._meta).toEqual({
        own: 1,
        "hors/result": expect.objectContaining({ status: "ok", mock: true }),
      });

      const structured = await client.callTool({ name: "structured", arguments: {} });
      expect(structured.structuredContent).toEqual({ ok: true });
      expect(resultMeta(structured).status).toBe("ok");

      const paid = await client.callTool({ name: "paid", arguments: {} });
      expect(paid.isError).toBe(true);
      expect(resultMeta(paid)).toMatchObject({
        code: "OVER_BUDGET",
        challenge: { price: 1 },
      });
    });
  });

  it("honours transport overrides and rejects invalid options (T7)", async () => {
    await withTempDir(async (home) => {
      let seen: HorsContext | undefined;
      const forcedHttp = await linkedPair(home, {
        transport: "http",
        config: { origins: ["https://work.example.com/mcp"] },
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, (_args, ctx) => {
            seen = ctx.hors;
            return { content: [{ type: "text", text: "ok" }] };
          });
        },
      });
      const signed = await signedCall(forcedHttp.client, forcedHttp.account, "same", { amount: 1 });
      expect(resultMeta(signed).status).toBe("ok");
      expect(seen?.local).toBe(false);
      expect(seen?.transport).toBe("mcp-http");

      const forcedStdio = await httpPair(home, {
        transport: "stdio",
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({
            content: [{ type: "text", text: "local" }],
          }));
        },
      });
      const local = await forcedStdio.client.callTool({ name: "same", arguments: { amount: 1 } });
      expect(resultMeta(local)).toMatchObject({ status: "ok", local: true, policy: "same-human" });

      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      await expect(hors(raw, { gate: built.gate, policy: "public" })).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
      const once = await hors(new McpServer({ name: "hors-test", version: "1.0.0" }), {
        gate: built.gate,
      });
      await expect(hors(once, { gate: built.gate })).rejects.toSatisfy((error) => {
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
      await expect(
        hors(new McpServer({ name: "hors-test", version: "1.0.0" }), {
          transport: "tcp" as never,
        }),
      ).rejects.toSatisfy((error) => {
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
    });
  });

  it("refuses a signed call when the inner server is connected around the wrapper (W6)", async () => {
    await withTempDir(async (home) => {
      const ran = vi.fn();
      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      const server = await hors(raw, { gate: built.gate });
      server.registerTool("same", { hors: "public" }, () => {
        ran();
        return { content: [] };
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "hors-test-client", version: "1.0.0" });
      trackMcpClose(async () => {
        await client.close();
        await raw.close();
      });
      await Promise.all([client.connect(clientTransport), raw.server.connect(serverTransport)]);
      const denied = await signedCall(client, built.account, "same", {});
      expect(resultMeta(denied).code).toBe("HORS_POLICY_ERROR");
      expect(ran).not.toHaveBeenCalled();
      expect(
        built.logs.some((event) => String(event.message).includes("no recorded arguments")),
      ).toBe(true);
      expect(built.audits).toEqual([]);
    });
  });

  it("creates its own gate when hors() is called without options.gate (D3)", async () => {
    await withTempDir(async (home) => {
      const key = generatePrivateKey();
      vi.stubEnv("HORS_HOME", home);
      vi.stubEnv("HORS_PRIVATE_KEY", key);
      try {
        const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
        const server = await hors(raw, { configFile: false, dev: { mockOrigin: true } });
        server.registerTool("open", { hors: "public" }, () => ({
          content: [{ type: "text", text: "ok" }],
        }));
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "hors-test-client", version: "1.0.0" });
        trackMcpClose(async () => {
          await client.close();
          await server.close();
        });
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        const ok = await client.callTool({ name: "open", arguments: {} });
        expect(resultMeta(ok)).toMatchObject({ status: "ok", mock: true, local: true });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("marks a seam-2 refusal over createMcpHandler as network (S2.3)", async () => {
    await withTempDir(async (home) => {
      const early = vi.fn(() => ({ content: [] }));
      const { client } = await httpPair(home, {
        beforeHors(server) {
          server.registerTool("early", {}, early);
        },
        setup() {
          // tools registered through hors() are unrelated to this refusal
        },
      });
      const denied = await client.callTool({ name: "early", arguments: {} });
      expect(resultMeta(denied)).toMatchObject({
        code: "HORS_POLICY_ERROR",
        local: false,
      });
      expect(early).not.toHaveBeenCalled();
    });
  });

  it("stamps hors keys in a fixed order for ok and deny results", async () => {
    await withTempDir(async (home) => {
      const { client } = await linkedPair(home, {
        setup(server) {
          server.registerTool("open", { hors: "public" }, () => ({ content: [] }));
          server.registerTool(
            "closed",
            {
              hors: {
                origin: "public",
                use: async (ctx) => ctx.deny("no"),
              },
            },
            () => ({ content: [] }),
          );
        },
      });
      const ok = await client.callTool({ name: "open", arguments: {} });
      expect(Object.keys(resultMeta(ok))).toEqual(["v", "status", "policy", "local", "mock"]);
      const deny = await client.callTool({ name: "closed", arguments: {} });
      expect(Object.keys(resultMeta(deny))).toEqual([
        "v",
        "status",
        "code",
        "reason",
        "policy",
        "challenge",
        "local",
        "mock",
      ]);
    });
  });

  it("omits the mock key when the gate is not in mock mode", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const gate = await buildGate(
        validateConfig({ dev: { mockOrigin: false }, policy: "public" }, { nodeEnv: undefined }),
        { env: { HORS_HOME: home }, log, agentBook: new MockAgentBook() },
      );
      const { client } = await linkedPair(home, {
        gate,
        setup(server) {
          server.registerTool("open", { hors: "public" }, () => ({ content: [] }));
        },
      });
      const ok = await client.callTool({ name: "open", arguments: {} });
      expect(resultMeta(ok)).toEqual({
        v: 1,
        status: "ok",
        policy: "public",
        local: true,
      });
      expect(resultMeta(ok)).not.toHaveProperty("mock");
    });
  });

  it("ignores hors/auth on tools/list (no pending, no evaluation)", async () => {
    await withTempDir(async (home) => {
      const { client, audits } = await linkedPair(home, {
        setup(server) {
          server.registerTool("open", { hors: "public" }, () => ({ content: [] }));
        },
      });
      const listed = await client.listTools({
        _meta: { "hors/auth": { v: 1 } },
      } as never);
      expect(listed.tools.map((tool) => tool.name)).toContain("open");
      expect(audits).toEqual([]);
    });
  });

  it("refuses both calls when two in-flight tools/call share an id", async () => {
    await withTempDir(async (home) => {
      const ran = vi.fn();
      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      const server = await hors(raw, { gate: built.gate });
      server.registerTool("same", { hors: "public", inputSchema: amountSchema }, () => {
        ran();
        return { content: [{ type: "text", text: "ran" }] };
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      trackMcpClose(async () => {
        await clientTransport.close();
        await server.close();
      });
      await server.connect(serverTransport);
      await clientTransport.start();
      const replies: unknown[] = [];
      clientTransport.onmessage = (message) => {
        replies.push(message);
      };
      const { raw: envelope } = await signedEnvelope(built.account, {
        fn: "same",
        argsHash: await hashArgs({ amount: 2 }),
      });
      await Promise.all([
        clientTransport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "same",
            arguments: { amount: 1 },
            _meta: { "hors/auth": envelope },
          },
        }),
        clientTransport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "same", arguments: { amount: 2 } },
        }),
      ]);
      await vi.waitFor(() => {
        expect(replies.length).toBeGreaterThanOrEqual(2);
      });
      expect(ran).not.toHaveBeenCalled();
      for (const reply of replies.slice(0, 2)) {
        expect(reply).toMatchObject({
          result: { isError: true, _meta: { "hors/result": { code: "HORS_POLICY_ERROR" } } },
        });
      }
      expect(built.audits.every((event) => event.status !== "ok" || event.fn !== "same")).toBe(
        true,
      );
      expect(built.audits.filter((event) => event.status === "ok")).toEqual([]);

      const sequential: unknown[] = [];
      clientTransport.onmessage = (message) => {
        sequential.push(message);
      };
      await clientTransport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "same", arguments: { amount: 1 } },
      });
      await vi.waitFor(() => {
        expect(sequential.length).toBeGreaterThanOrEqual(1);
      });
      expect(ran).toHaveBeenCalledOnce();
    });
  });

  it("throws when hors() is applied to an already-connected server", async () => {
    await withTempDir(async (home) => {
      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      trackMcpClose(async () => {
        await clientTransport.close();
        await raw.close();
      });
      await raw.connect(serverTransport);
      await expect(hors(raw, { gate: built.gate })).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        expect((error as HorsError).message).toContain("apply hors() before connect");
        return true;
      });
    });
  });

  it("does not record a tools/call with a float id or a non-object _meta", async () => {
    await withTempDir(async (home) => {
      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      const server = await hors(raw, { gate: built.gate });
      server.registerTool("same", { hors: "public" }, () => ({ content: [] }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      trackMcpClose(async () => {
        await clientTransport.close();
        await server.close();
      });
      await server.connect(serverTransport);
      await clientTransport.start();
      const replies: unknown[] = [];
      clientTransport.onmessage = (message) => {
        replies.push(message);
      };
      await clientTransport.send({
        jsonrpc: "2.0",
        id: 1.5,
        method: "tools/call",
        params: { name: "same", arguments: {} },
      });
      await clientTransport.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "same", arguments: {}, _meta: [] as never },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(built.logs.some((event) => String(event.message).includes("hors mcp"))).toBe(false);
      expect(replies).not.toContainEqual(
        expect.objectContaining({
          result: { _meta: { "hors/result": { code: "HORS_POLICY_ERROR" } } },
        }),
      );
    });
  });

  it("logs when a seam-2 refusal cannot be sent", async () => {
    await withTempDir(async (home) => {
      const built = await testGate(home);
      const raw = new McpServer({ name: "hors-test", version: "1.0.0" });
      const server = await hors(raw, { gate: built.gate });
      const failing = {
        start: async () => undefined,
        close: async () => undefined,
        send: async () => {
          throw new Error("closed stream");
        },
        onmessage: undefined as ((message: unknown, extra?: unknown) => void) | undefined,
      };
      await server.connect(failing as never);
      failing.onmessage?.(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "outside" } },
        undefined,
      );
      await vi.waitFor(() => {
        expect(
          built.logs.some(
            (event) =>
              event.level === "error" &&
              String(event.message).includes("could not send the refusal"),
          ),
        ).toBe(true);
      });
    });
  });
});
