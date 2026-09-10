import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../src/index.js";

const read = async (url: URL) => JSON.parse(await readFile(url, "utf8"));
const cli = await read(new URL("../package.json", import.meta.url));
const sdk = await read(new URL("../../hors-sdk/package.json", import.meta.url));
const skill = await readFile(new URL("../skills/use-hors/SKILL.md", import.meta.url), "utf8");

describe("hors-cli package manifest", () => {
  it("is an ESM-only package for Node 22.18+ under the MIT license", () => {
    expect(cli.name).toBe("hors-cli");
    expect(cli.type).toBe("module");
    expect(cli.license).toBe("MIT");
    expect(cli.engines.node).toBe(">=22.18.0");
    expect(cli.files).toEqual(["dist", "skills"]);
  });

  it("is released with hors-sdk at the same version and pins protocol deps exactly", () => {
    expect(cli.version).toBe(sdk.version);
    expect(cli.dependencies).toEqual({
      "@modelcontextprotocol/client": "2.0.0",
      "@modelcontextprotocol/server": "2.0.0",
      "@worldcoin/agentkit-core": "0.2.1",
      commander: "15.0.0",
      "hors-sdk": "workspace:*",
      viem: "2.56.3",
      zod: "4.5.4",
    });
    expect(cli.bin.hors).toBe("./dist/bin.js");
    expect(cli.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
  });

  it("ships the use-hors skill with the human-boundary connect step (T11, K1)", () => {
    expect(skill.startsWith("---\nname: use-hors\n")).toBe(true);
    expect(skill).toMatch(/hors connect/);
    expect(skill).toMatch(/visible terminal/);
    expect(skill).not.toMatch(/--fresh|list-functions|hors watch/);
  });

  it.skipIf(!existsSync(fileURLToPath(new URL("../dist/bin.js", import.meta.url))))(
    "points bin.hors at a built file with a shebang (needs pnpm build)",
    async () => {
      const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
      const text = await readFile(bin, "utf8");
      expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
    },
  );
});
