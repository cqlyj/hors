import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSigner } from "../src/client/index.js";
import { writeAddressBook } from "../src/config/address-book.js";
import { isPlainObject } from "../src/plain.js";
import { closeMcpPairs, httpPair } from "./helpers/mcp.js";
import { withTempHome } from "./helpers/tmp.js";

const amountSchema = z.object({ amount: z.number() });

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeMcpPairs();
});

describe("Signer.call", () => {
  it("returns ok with a hors stamp against a horsed HTTP MCP server", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({
            content: [{ type: "text", text: "ok" }],
          }));
        },
      });
      const close = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      const outcome = await signer.call("https://work.example.com/mcp", "same", { amount: 1 });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.hors).toMatchObject({ status: "ok", local: false, mock: true });
      }
      expect(close).toHaveBeenCalled();
      close.mockRestore();
    });
  });

  it("returns a denial outcome for another human without throwing", async () => {
    await withTempHome(async (home) => {
      const { handler } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { inputSchema: amountSchema }, () => ({ content: [] }));
        },
      });
      const other = privateKeyToAccount(generatePrivateKey());
      const signer = await createSigner({
        account: other,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      const outcome = await signer.call("https://work.example.com/mcp", "same", { amount: 1 });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("HORS_ORIGIN_MISMATCH");
      }
    });
  });

  it("surfaces a middleware challenge", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
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
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      const outcome = await signer.call("https://work.example.com/mcp", "paid", {});
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.challenge).toEqual({ price: 1 });
        expect(outcome.code).toBe("OVER_BUDGET");
      }
    });
  });

  it("keeps a tool isError without HORS as ok: true", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { hors: "public" }, () => ({
            isError: true,
            content: [{ type: "text", text: "tool" }],
          }));
        },
      });
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      const outcome = await signer.call("https://work.example.com/mcp", "same", {});
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.result.isError).toBe(true);
      }
    });
  });

  it("returns hors: null for an un-horsed server", async () => {
    await withTempHome(async (_home) => {
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "plain", version: "1.0.0" });
        server.registerTool("same", {}, () => ({ content: [{ type: "text", text: "ok" }] }));
        return server;
      });
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      const outcome = await signer.call("https://work.example.com/mcp", "same", {});
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.hors).toBeNull();
      }
    });
  });

  it("forwards cache home and cache: false to resolve", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { hors: "public" }, () => ({ content: [] }));
        },
      });
      await writeAddressBook(home, { work: "https://work.example.com/mcp" });
      const fetchImpl: typeof fetch = (input, init) => handler.fetch(new Request(input, init));
      const fromHome = await createSigner({
        account,
        fetch: fetchImpl,
        cache: { home },
      });
      expect((await fromHome.call("work", "same", {})).ok).toBe(true);
      const noBook = await createSigner({ account, fetch: fetchImpl, cache: false });
      await expect(noBook.call("work", "same", {})).rejects.toMatchObject({
        code: "RESOLVER_FAILED",
      });
    });
  });

  it("resolves an address-book name and fails an unknown service", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { hors: "public" }, () => ({ content: [] }));
        },
      });
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
        services: { work: "https://work.example.com/mcp" },
      });
      const outcome = await signer.call("work", "same", {});
      expect(outcome.ok).toBe(true);
      await expect(signer.call("nope", "same", {})).rejects.toMatchObject({
        code: "RESOLVER_FAILED",
      });
    });
  });

  it("returns the outcome when close() rejects", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { hors: "public" }, () => ({
            content: [{ type: "text", text: "ok" }],
          }));
        },
      });
      const close = vi
        .spyOn(StreamableHTTPClientTransport.prototype, "close")
        .mockRejectedValue(new Error("already closed"));
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      const outcome = await signer.call("https://work.example.com/mcp", "same", {});
      expect(outcome.ok).toBe(true);
      close.mockRestore();
    });
  });

  it("rejects an already-aborted signal and still closes the transport", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { hors: "public" }, () => ({ content: [] }));
        },
      });
      const close = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      const signal = AbortSignal.abort();
      await expect(
        signer.call("https://work.example.com/mcp", "same", {}, { signal }),
      ).rejects.toBeTruthy();
      expect(close).toHaveBeenCalled();
      close.mockRestore();
    });
  });

  it("omits the arguments key when args is undefined", async () => {
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { hors: "public" }, () => ({ content: [] }));
        },
      });
      const seen: unknown[] = [];
      const original = Client.prototype.callTool;
      const spy = vi.spyOn(Client.prototype, "callTool").mockImplementation(function (
        this: Client,
        params,
        options,
      ) {
        seen.push(params);
        return original.call(this, params, options);
      });
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      await signer.call("https://work.example.com/mcp", "same", undefined);
      expect(seen.some((params) => isPlainObject(params) && !("arguments" in params))).toBe(true);
      spy.mockRestore();
    });
  });

  it("throws HORS_POLICY_ERROR for a malformed hors/result stamp", async () => {
    const { readResult } = await import("../src/client/http.js");
    const { encodeHeaderJson } = await import("../src/http/envelope-header.js");
    expect(readResult(new Response("ok"))).toBeNull();
    const okStamp = { v: 1 as const, status: "ok" as const, policy: "public", local: false };
    expect(
      readResult(new Response("ok", { headers: { "HORS-Result": encodeHeaderJson(okStamp) } })),
    ).toEqual(okStamp);
    for (const stamp of [
      { v: 2, status: "deny" },
      { v: 1, status: "weird" },
    ]) {
      expect(() =>
        readResult(new Response("ok", { headers: { "HORS-Result": encodeHeaderJson(stamp) } })),
      ).toThrow(/malformed hors\/result/);
    }
    await withTempHome(async (home) => {
      const { handler, account } = await httpPair(home, {
        setup(server) {
          server.registerTool("same", { hors: "public" }, () => ({ content: [] }));
        },
      });
      const signer = await createSigner({
        account,
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      });
      for (const stamp of [
        { v: 2, status: "deny" },
        { v: 1, status: "weird" },
      ]) {
        const spy = vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
          content: [],
          _meta: { "hors/result": stamp },
        });
        await expect(signer.call("https://work.example.com/mcp", "same", {})).rejects.toMatchObject(
          {
            code: "HORS_POLICY_ERROR",
          },
        );
        spy.mockRestore();
      }
    });
  });
});
