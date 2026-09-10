import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { fakeIo } from "./helpers/io.js";
import { withTempDir } from "./helpers/tmp.js";

describe("hors services (T4)", () => {
  it("prints nothing for an empty book", async () => {
    await withTempDir(async (home) => {
      const { io, out } = fakeIo({});
      expect(await run(["services", "--home", home], io)).toBe(0);
      expect(out).toEqual([]);
    });
  });

  it("adds, lists sorted, and removes entries", async () => {
    await withTempDir(async (home) => {
      const { io, out } = fakeIo({});
      expect(
        await run(["services", "add", "work", "https://work.example.com/mcp", "--home", home], io),
      ).toBe(0);
      expect(out).toContain("added work → https://work.example.com/mcp");
      out.length = 0;
      expect(await run(["services", "add", "alpha", "alpha.eth", "--home", home], io)).toBe(0);
      out.length = 0;
      expect(await run(["services", "--home", home, "--json"], io)).toBe(0);
      expect(out.map((line) => JSON.parse(line))).toEqual([
        { name: "alpha", uri: "alpha.eth" },
        { name: "work", uri: "https://work.example.com/mcp" },
      ]);
      out.length = 0;
      expect(await run(["services", "rm", "alpha", "--home", home], io)).toBe(0);
      expect(out).toContain("removed alpha");
      const info = await stat(join(home, "services.json"));
      if (process.platform !== "win32") {
        expect(info.mode & 0o777).toBe(0o600);
      }
    });
  });

  it("rejects invalid names and URIs with exit 2", async () => {
    await withTempDir(async (home) => {
      const { io } = fakeIo({});
      const bad: Array<[string, string]> = [
        ["https://x.example/mcp", "https://ok.example/mcp"],
        ["ok", "https://user:pass@host.example/mcp"],
        ["ok", "ftp://host.example/mcp"],
        ["ok", "ens:has space"],
        ["ok", "erc8004:eip155:0/1"],
        ["ok", "erc8004:eip155:01/1"],
        ["ok", "ens:a\u0000b"],
      ];
      for (const [name, uri] of bad) {
        expect(
          await run(["services", "add", name, uri, "--home", home], io),
          JSON.stringify({ name, uri }),
        ).toBe(2);
      }
    });
  });
});
