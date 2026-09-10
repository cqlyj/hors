import { writeAddressBook } from "hors-sdk/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { fakeIo } from "./helpers/io.js";
import { pinProfile } from "./helpers/profile.js";
import { startService, type TestService } from "./helpers/service.js";
import { withTempDir } from "./helpers/tmp.js";

describe("hors list / call (T7)", () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startService();
  });

  afterAll(async () => {
    await service.close();
  });

  it("lists echo with an args summary and published policy", async () => {
    await withTempDir(async (home) => {
      await writeAddressBook(home, { work: "https://work.example.com/mcp" });
      const { io, out } = fakeIo({ fetch: service.fetch });
      expect(await run(["list", "work", "--home", home], io)).toBe(0);
      expect(out.join("\n")).toMatch(/echo/);
      expect(out.join("\n")).toMatch(/args:/);
      expect(out.join("\n")).toMatch(/policy: origin=any-human name=any-human custom=false/);
      const wrapHuman = out.join("\n");
      expect(wrapHuman).toMatch(/wrap\n {2}line1 line2 tab/);
      expect(wrapHuman).not.toMatch(/line1\nline2/);
      service.incoming.length = 0;
      out.length = 0;
      expect(await run(["list", "work", "--home", home, "--json"], io)).toBe(0);
      const rows = out.map((line) => JSON.parse(line) as { name: string; policy: unknown });
      const echo = rows.find((row) => row.name === "echo");
      expect(echo?.policy).toMatchObject({ name: "any-human", origin: ["any-human"] });
      expect(echo).toHaveProperty("inputSchema");
      const wrap = rows.find((row) => row.name === "wrap") as { description: string } | undefined;
      expect(wrap?.description).toBe("line1\nline2\ttab");
      expect(service.incoming.every((req) => req.headers.get("hors-authorization") === null)).toBe(
        true,
      );
    });
  });

  it("resolves an address-book name from --home, not HORS_HOME", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (other) => {
        await pinProfile(home);
        await writeAddressBook(home, { work: "https://work.example.com/mcp" });
        const { io, out } = fakeIo({ fetch: service.fetch, env: { HORS_HOME: other } });
        expect(await run(["call", "work", "echo", '{"a":1}', "--home", home], io)).toBe(0);
        expect(out.join("\n")).toContain('"a":1');
      });
    });
  });

  it("calls echo and denies the deny tool", async () => {
    await withTempDir(async (home) => {
      await pinProfile(home);
      await writeAddressBook(home, { work: "https://work.example.com/mcp" });
      const { io, out } = fakeIo({ fetch: service.fetch });
      expect(await run(["call", "work", "echo", '{"a":1}', "--home", home], io)).toBe(0);
      expect(out.join("\n")).toContain('"a":1');
      out.length = 0;
      expect(await run(["call", "work", "deny", "{}", "--home", home], io)).toBe(3);
      expect(out[0]).toMatch(/^denied HORS_RULE_DENIED:/);
      expect(out.some((line) => line.startsWith("challenge:"))).toBe(true);
      out.length = 0;
      expect(await run(["call", "work", "deny", "{}", "--home", home, "--json"], io)).toBe(3);
      const denied = JSON.parse(out[0] ?? "{}") as { ok: boolean; code: string };
      expect(denied).toMatchObject({ ok: false, code: "HORS_RULE_DENIED" });
    });
  });

  it("strips terminal escape sequences from human tool output", async () => {
    await withTempDir(async (home) => {
      await pinProfile(home);
      await writeAddressBook(home, { work: "https://work.example.com/mcp" });
      const { io, out } = fakeIo({ fetch: service.fetch });
      expect(await run(["call", "work", "paint", "--home", home], io)).toBe(0);
      expect(out.join("\n")).toContain(" [31mred");
      expect(out.join("\n")).not.toContain("\u001b");
      out.length = 0;
      expect(await run(["call", "work", "paint", "--home", home, "--json"], io)).toBe(0);
      expect(out[0]).toContain("\\u001b[31mred");
      const parsed = JSON.parse(out[0] ?? "{}") as {
        result: { content: Array<{ text?: string }> };
      };
      expect(parsed.result.content[0]?.text).toBe("\u001b[31mred");
    });
  });

  it("rejects invalid [json], unknown services, and a missing profile", async () => {
    await withTempDir(async (home) => {
      const { io } = fakeIo({ fetch: service.fetch });
      expect(await run(["call", "work", "echo", "[1]", "--home", home], io)).toBe(2);
      expect(await run(["list", "nope", "--home", home], io)).toBe(1);
      expect(
        await run(["call", "https://work.example.com/mcp", "echo", "{}", "--home", home], io),
      ).toBe(4);
    });
  });
});
