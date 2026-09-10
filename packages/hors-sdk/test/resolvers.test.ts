import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HorsError } from "../src/errors.js";
import { ens, ensRuntime } from "../src/resolvers/ens.js";
import { erc8004, erc8004Runtime } from "../src/resolvers/erc8004.js";
import { classifyService, resolve } from "../src/resolvers/resolve.js";
import { withTempDir } from "./helpers/tmp.js";

function dataUri(body: unknown): string {
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:application/json;base64,${btoa(binary)}`;
}

describe("resolvers", () => {
  it("classifies URLs, ENS names and strict erc8004 URIs", () => {
    expect(classifyService("https://a/b")).toBe("url");
    expect(classifyService("http://a")).toBe("url");
    expect(classifyService("ens:x.eth")).toBe("ens");
    expect(classifyService("erc8004:eip155:1/7")).toBe("erc8004");
    expect(classifyService("alice.eth")).toBe("ens");
    expect(classifyService("https://u:p@a/")).toBeUndefined();
    expect(classifyService("erc8004:garbage")).toBeUndefined();
    expect(classifyService("erc8004:eip155:0/1")).toBeUndefined();
    expect(classifyService("erc8004:eip155:01/1")).toBeUndefined();
    expect(classifyService("ens:a\u0000b")).toBeUndefined();
    expect(classifyService("not a uri")).toBeUndefined();
    expect(classifyService("")).toBeUndefined();
  });

  it("lets options.services win over a URL-looking name", async () => {
    const url = await resolve("https://looks.like/a-url", {
      services: { "https://looks.like/a-url": "https://mapped.example/mcp" },
      cache: false,
    });
    expect(url).toBe("https://mapped.example/mcp");
  });

  it("resolves ens: and a bare .eth name through ens()", async () => {
    const text = vi.spyOn(ensRuntime, "text").mockResolvedValue("https://mcp.example.com");
    expect(await ens("openagents.eth", { cache: false })).toBe("https://mcp.example.com");
    expect(await resolve("ens:openagents.eth", { cache: false })).toBe("https://mcp.example.com");
    expect(await resolve("openagents.eth", { cache: false })).toBe("https://mcp.example.com");
    text.mockResolvedValue("http://insecure.example");
    await expect(ens("openagents.eth", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
    });
    text.mockResolvedValue(null);
    await expect(ens("openagents.eth", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
    });
    text.mockRejectedValue(new Error("viem down"));
    await expect(ens("openagents.eth", { cache: false })).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("RESOLVER_FAILED");
      expect((error as HorsError).cause).toEqual(expect.objectContaining({ message: "viem down" }));
      expect((error as HorsError).message).not.toContain("viem down");
      return true;
    });
    text.mockRestore();
  });

  it("selects the MCP service from an erc8004 registration file", async () => {
    const tokenURI = vi.spyOn(erc8004Runtime, "tokenURI").mockResolvedValue(
      dataUri({
        services: [
          { name: "a2a", endpoint: "https://a2a.example/" },
          { name: "mcp", endpoint: "https://mcp.example.com/" },
        ],
      }),
    );
    expect(await erc8004("erc8004:eip155:8453/42", { cache: false })).toBe(
      "https://mcp.example.com/",
    );
    tokenURI.mockRestore();
  });

  it("fetches an ipfs registration file through the gateway", async () => {
    const tokenURI = vi
      .spyOn(erc8004Runtime, "tokenURI")
      .mockResolvedValue("ipfs://bafytestcid/agent.json");
    const fetchImpl = vi.fn(async (input: Request | URL | string) => {
      expect(String(input)).toBe("https://ipfs.io/ipfs/bafytestcid/agent.json");
      return new Response(
        JSON.stringify({ services: [{ name: "MCP", endpoint: "https://mcp.example.com/" }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    expect(await erc8004("erc8004:eip155:8453/42", { cache: false, fetch: fetchImpl })).toBe(
      "https://mcp.example.com/",
    );
    tokenURI.mockRestore();
  });

  it("fails a registration file over 1 MiB and a file with no MCP entry", async () => {
    const tokenURI = vi
      .spyOn(erc8004Runtime, "tokenURI")
      .mockResolvedValue("https://reg.example/agent.json");
    await expect(
      erc8004("erc8004:eip155:8453/42", {
        cache: false,
        fetch: async () =>
          new Response("x".repeat(1_048_577), { headers: { "content-length": "1048577" } }),
      }),
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    tokenURI.mockResolvedValue(dataUri({ services: [{ name: "a2a", endpoint: "https://x" }] }));
    await expect(erc8004("erc8004:eip155:8453/42", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
      message: expect.stringContaining("no MCP service"),
    });
    tokenURI.mockRestore();
  });

  it("rejects a chain with no RPC and malformed erc8004 URIs", async () => {
    await expect(erc8004("erc8004:eip155:999999/1", { cache: false })).rejects.toSatisfy(
      (error) => {
        expect((error as HorsError).message).toContain("no RPC for eip155:999999");
        return true;
      },
    );
    for (const uri of ["erc8004:eip155:1", "erc8004:solana:x/1", "erc8004:eip155:1/-1"]) {
      await expect(erc8004(uri, { cache: false })).rejects.toMatchObject({
        code: "RESOLVER_FAILED",
      });
    }
  });

  it("caches a resolver URI and serves the hit without calling ENS again", async () => {
    await withTempDir(async (home) => {
      const text = vi.spyOn(ensRuntime, "text").mockResolvedValue("https://mcp.example.com");
      expect(await resolve("ens:openagents.eth", { cache: { home } })).toBe(
        "https://mcp.example.com",
      );
      const written = JSON.parse(await readFile(join(home, "cache", "resolve.json"), "utf8"));
      expect(written["ens:openagents.eth"].url).toBe("https://mcp.example.com");
      if (process.platform !== "win32") {
        expect(
          (await import("node:fs/promises").then((fs) => fs.stat(join(home, "cache")))).mode &
            0o777,
        ).toBe(0o700);
      }
      text.mockClear();
      expect(await resolve("ens:openagents.eth", { cache: { home } })).toBe(
        "https://mcp.example.com",
      );
      expect(text).not.toHaveBeenCalled();
      text.mockRestore();
    });
  });

  it("refreshes a cache entry and ignores a stale at: 0", async () => {
    await withTempDir(async (home) => {
      const text = vi.spyOn(ensRuntime, "text").mockResolvedValue("https://mcp.example.com");
      await resolve("ens:openagents.eth", { cache: { home } });
      text.mockClear();
      await resolve("ens:openagents.eth", { cache: { home }, refresh: true });
      expect(text).toHaveBeenCalled();
      await writeFile(
        join(home, "cache", "resolve.json"),
        JSON.stringify({ "ens:openagents.eth": { url: "https://stale.example", at: 0 } }),
      );
      text.mockClear();
      await resolve("ens:openagents.eth", { cache: { home } });
      expect(text).toHaveBeenCalled();
      text.mockRestore();
    });
  });

  it("ignores a corrupt cache file and cache: false skips the filesystem", async () => {
    await withTempDir(async (home) => {
      const text = vi.spyOn(ensRuntime, "text").mockResolvedValue("https://mcp.example.com");
      await mkdir(join(home, "cache"), { recursive: true });
      await writeFile(join(home, "cache", "resolve.json"), "not-json");
      await resolve("ens:openagents.eth", { cache: { home } });
      expect(text).toHaveBeenCalled();
      text.mockClear();
      await resolve("ens:openagents.eth", { cache: false });
      expect(text).toHaveBeenCalled();
      text.mockRestore();
    });
  });

  it("honours services.json and lets options.services win", async () => {
    await withTempDir(async (home) => {
      await writeFile(
        join(home, "services.json"),
        JSON.stringify({ work: "https://from-file.example/mcp" }),
      );
      expect(await resolve("work", { cache: { home } })).toBe("https://from-file.example/mcp");
      expect(
        await resolve("work", {
          cache: { home },
          services: { work: "https://from-options.example/mcp" },
        }),
      ).toBe("https://from-options.example/mcp");
    });
  });

  it("treats future, string, and numeric-url cache entries as misses", async () => {
    await withTempDir(async (home) => {
      const text = vi.spyOn(ensRuntime, "text").mockResolvedValue("https://mcp.example.com");
      await mkdir(join(home, "cache"), { recursive: true });
      for (const entry of [
        { url: "https://cached.example", at: Date.now() + 60_000 },
        { url: "https://cached.example", at: "soon" },
        { url: 1, at: Date.now() },
      ]) {
        await writeFile(
          join(home, "cache", "resolve.json"),
          JSON.stringify({ "ens:openagents.eth": entry }),
        );
        text.mockClear();
        await resolve("ens:openagents.eth", { cache: { home } });
        expect(text).toHaveBeenCalled();
      }
      text.mockRestore();
    });
  });

  it("rejects credentialed endpoints, malformed ipfs paths, and bad data URIs", async () => {
    await expect(
      resolve("https://user:pass@host.example/mcp", { cache: false }),
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    const text = vi
      .spyOn(ensRuntime, "text")
      .mockResolvedValue("https://user:pass@host.example/mcp");
    await expect(ens("openagents.eth", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
    });
    text.mockRestore();
    const tokenURI = vi.spyOn(erc8004Runtime, "tokenURI").mockResolvedValue("ipfs://bafy/foo/../x");
    await expect(erc8004("erc8004:eip155:8453/42", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
      message: expect.stringContaining("malformed ipfs URI"),
    });
    tokenURI.mockResolvedValue("data:application/json;base64,%%%");
    await expect(erc8004("erc8004:eip155:8453/42", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
    });
    tokenURI.mockResolvedValue("data:application/json,%E0%A4%A");
    await expect(erc8004("erc8004:eip155:8453/42", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
    });
    tokenURI.mockResolvedValue(42 as unknown as string);
    await expect(erc8004("erc8004:eip155:8453/42", { cache: false })).rejects.toMatchObject({
      code: "RESOLVER_FAILED",
      message: expect.stringContaining("tokenURI is not a string"),
    });
    tokenURI.mockRestore();
  });

  it("rejects an address-book name that is not mapped and a malformed services.json", async () => {
    await withTempDir(async (home) => {
      await expect(resolve("missing-name", { cache: { home } })).rejects.toMatchObject({
        code: "RESOLVER_FAILED",
      });
      await writeFile(join(home, "services.json"), JSON.stringify({ work: 1 }));
      await expect(resolve("work", { cache: { home } })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
    });
  });

  it("times out a hanging registration fetch", async () => {
    vi.useFakeTimers();
    const tokenURI = vi
      .spyOn(erc8004Runtime, "tokenURI")
      .mockResolvedValue("https://reg.example/agent.json");
    const pending = erc8004("erc8004:eip155:8453/42", {
      cache: false,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const expectFailed = expect(pending).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expectFailed;
    tokenURI.mockRestore();
    vi.useRealTimers();
  });

  it("times out a hanging registration body after headers", async () => {
    vi.useFakeTimers();
    const tokenURI = vi
      .spyOn(erc8004Runtime, "tokenURI")
      .mockResolvedValue("https://reg.example/agent.json");
    const pending = erc8004("erc8004:eip155:8453/42", {
      cache: false,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // never closes
            },
          }),
        ),
    });
    const expectFailed = expect(pending).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    await vi.advanceTimersByTimeAsync(10_000);
    await expectFailed;
    tokenURI.mockRestore();
    vi.useRealTimers();
  });

  it("caps a streamed registration file after 17 64 KiB chunks", async () => {
    const tokenURI = vi
      .spyOn(erc8004Runtime, "tokenURI")
      .mockResolvedValue("https://reg.example/agent.json");
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      erc8004("erc8004:eip155:8453/42", {
        cache: false,
        fetch: async () => new Response(stream),
      }),
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    expect(pulls).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
    tokenURI.mockRestore();
  });
});
