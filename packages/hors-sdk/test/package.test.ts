import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import "../src/index.js";
import { VERSION } from "../src/version.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const distRoot = new URL("../dist/", import.meta.url);

async function walkJs(dir: URL): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) {
      files.push(...(await walkJs(url)));
    } else if (entry.name.endsWith(".js")) {
      files.push(url.pathname);
    }
  }
  return files;
}

describe("hors-sdk package manifest", () => {
  it("is an ESM-only library for Node 22.18+ under the MIT license", () => {
    expect(manifest.name).toBe("hors-sdk");
    expect(manifest.type).toBe("module");
    expect(manifest.license).toBe("MIT");
    expect(manifest.engines.node).toBe(">=22.18.0");
  });

  it("exposes the root, world, mcp, http, client, resolvers and node entry points", () => {
    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      "./world",
      "./mcp",
      "./http",
      "./client",
      "./resolvers",
      "./node",
    ]);
    expect(manifest.exports["./node"]).toEqual({
      types: "./dist/node/index.d.ts",
      default: "./dist/node/index.js",
    });
    expect(manifest.exports["./http"]).toEqual({
      types: "./dist/http/index.d.ts",
      default: "./dist/http/index.js",
    });
    expect(manifest.exports["./client"]).toEqual({
      types: "./dist/client/index.d.ts",
      default: "./dist/client/index.js",
    });
    expect(manifest.exports["./resolvers"]).toEqual({
      types: "./dist/resolvers/index.d.ts",
      default: "./dist/resolvers/index.js",
    });
    expect(manifest.files).toEqual(["dist"]);
  });

  it("declares optional MCP peers and lists express as a devDependency", () => {
    expect(Object.keys(manifest.peerDependencies)).toEqual([
      "@modelcontextprotocol/server",
      "@modelcontextprotocol/client",
      "@worldcoin/agentkit-core",
      "viem",
    ]);
    expect(manifest.peerDependenciesMeta["@modelcontextprotocol/server"]).toEqual({
      optional: true,
    });
    expect(manifest.peerDependenciesMeta["@modelcontextprotocol/client"]).toEqual({
      optional: true,
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies)).toEqual([
      "@modelcontextprotocol/client",
      "@modelcontextprotocol/server",
      "@worldcoin/agentkit-core",
      "express",
      "viem",
      "zod",
    ]);
  });

  it("exports only hors from the mcp entry", async () => {
    expect(Object.keys(await import("../src/mcp/index.js")).sort()).toEqual(["hors"]);
  });

  it("exports only the root public names", async () => {
    expect(Object.keys(await import("../src/index.js")).sort()).toEqual([
      "HorsError",
      "MemoryStore",
      "createGate",
      "defineConfig",
      "definePolicy",
      "hashArgs",
      "hashBody",
      "isPlainObject",
    ]);
  });

  it("keeps VERSION equal to package.json", () => {
    expect(VERSION).toBe(manifest.version);
  });

  it("has no static node: or MCP imports in http/client and only cache.js in resolvers", async () => {
    const banned = /from "(node:|@modelcontextprotocol)/;
    const hits: string[] = [];
    for (const folder of ["http", "client", "resolvers"]) {
      let files: string[];
      try {
        files = await walkJs(new URL(`${folder}/`, distRoot));
      } catch {
        continue;
      }
      for (const file of files) {
        const text = await readFile(file, "utf8");
        if (!banned.test(text)) {
          continue;
        }
        if (folder === "resolvers" && file.endsWith("/cache.js")) {
          continue;
        }
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });

  it("loads resolvers from the client only via a dynamic import", async () => {
    const files = await walkJs(new URL("client/", distRoot));
    const mentions: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const line of text.split("\n")) {
        if (line.includes("resolvers")) {
          mentions.push(`${file}:${line.trim()}`);
        }
      }
    }
    expect(mentions.length).toBeGreaterThan(0);
    expect(mentions.every((line) => line.includes("import("))).toBe(true);
  });

  it("allows node: imports only in config, node, gate/gate.js and resolvers/cache.js", async () => {
    const files = await walkJs(distRoot);
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (!/from "node:/.test(text)) {
        continue;
      }
      const allowed =
        file.includes("/dist/config/") ||
        file.includes("/dist/node/") ||
        file.endsWith("/gate/gate.js") ||
        file.endsWith("/resolvers/cache.js");
      if (!allowed) {
        hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});
