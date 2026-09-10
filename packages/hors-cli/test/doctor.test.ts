import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProfile } from "hors-sdk/node";
import { MockAgentBook } from "hors-sdk/world";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { fakeIo } from "./helpers/io.js";
import { pinProfile } from "./helpers/profile.js";
import { withTempDir } from "./helpers/tmp.js";

describe("hors doctor (T9)", () => {
  it("exits 0 with ok lines when every check passes", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (cwd) => {
        await pinProfile(home);
        await writeFile(
          join(cwd, "hors.config.json"),
          JSON.stringify({ rpc: { worldchain: "https://rpc.example.com" } }),
        );
        const now = Date.parse("2026-09-09T00:00:00.000Z");
        const { io, out } = fakeIo({
          cwd,
          agentBook: new MockAgentBook(),
          now: () => now,
          worldChainBlock: async () => ({ number: 1n, timestamp: BigInt(Math.floor(now / 1000)) }),
        });
        expect(await run(["doctor", "--home", home], io)).toBe(0);
        expect(out.every((line) => line.startsWith("ok  ") || line.startsWith("warn  "))).toBe(
          true,
        );
        expect(out.some((line) => line.startsWith("fail  "))).toBe(false);
      });
    });
  });

  it("fails when the profile is missing", async () => {
    await withTempDir(async (home) => {
      const { io, out } = fakeIo({
        worldChainBlock: async () => ({ number: 1n, timestamp: 1n }),
      });
      expect(await run(["doctor", "--home", home], io)).toBe(1);
      expect(out.some((line) => line.startsWith("fail  profile:"))).toBe(true);
    });
  });

  it("fails a world-readable key and warns on skew, default RPC, and HORS_PRIVATE_KEY", async () => {
    await withTempDir(async (home) => {
      await pinProfile(home);
      if (process.platform !== "win32") {
        await chmod(join(home, "default", "key"), 0o644);
      }
      const now = 1_000_000_000_000;
      const { io, out } = fakeIo({
        env: { HORS_PRIVATE_KEY: `0x${"11".repeat(32)}` },
        now: () => now,
        worldChainBlock: async () => ({
          number: 1n,
          timestamp: BigInt(Math.floor(now / 1000) - 120),
        }),
      });
      const code = await run(["doctor", "--home", home], io);
      if (process.platform !== "win32") {
        expect(code).toBe(1);
        expect(out.some((line) => line.startsWith("fail  key:"))).toBe(true);
      }
      expect(out.some((line) => line.includes("clock skew 120s"))).toBe(true);
      expect(out.some((line) => line.includes("public default World Chain RPC"))).toBe(true);
    });
  });

  it("warns when HORS_PRIVATE_KEY is set without an owner or pin", async () => {
    await withTempDir(async (home) => {
      const { io, out } = fakeIo({
        env: { HORS_PRIVATE_KEY: `0x${"11".repeat(32)}` },
        worldChainBlock: async () => ({ number: 1n, timestamp: 1n }),
      });
      await run(["doctor", "--home", home], io);
      expect(out.some((line) => line.includes("HORS_PRIVATE_KEY without HORS_OWNER"))).toBe(true);
    });
  });

  it("emits unique --json check names and warns on the default RPC", async () => {
    await withTempDir(async (home) => {
      const { io, out } = fakeIo({
        worldChainBlock: async () => ({ number: 1n, timestamp: 1n }),
      });
      await run(["doctor", "--home", home, "--json"], io);
      const payload = JSON.parse(out[0] ?? "{}") as {
        ok: boolean;
        checks: Array<{ name: string; status: string; detail: string }>;
      };
      expect(payload).toHaveProperty("ok");
      expect(Array.isArray(payload.checks)).toBe(true);
      expect(payload.checks[0]).toHaveProperty("name");
      const names = payload.checks.map((check) => check.name);
      expect(new Set(names).size).toBe(names.length);
      expect(payload.checks.find((check) => check.name === "rpc")).toMatchObject({
        status: "warn",
      });
      expect(payload.checks.some((check) => check.name === "owner")).toBe(false);
    });
  });

  it("marks rpc ok when a World Chain RPC is configured", async () => {
    await withTempDir(async (home) => {
      await withTempDir(async (cwd) => {
        await writeFile(
          join(cwd, "hors.config.json"),
          JSON.stringify({ rpc: { worldchain: "https://rpc.example.com" } }),
        );
        const { io, out } = fakeIo({
          cwd,
          worldChainBlock: async () => ({ number: 9n, timestamp: 1n }),
        });
        await run(["doctor", "--home", home, "--json"], io);
        const payload = JSON.parse(out[0] ?? "{}") as {
          checks: Array<{ name: string; status: string; detail: string }>;
        };
        const names = payload.checks.map((check) => check.name);
        expect(new Set(names).size).toBe(names.length);
        expect(payload.checks.find((check) => check.name === "rpc")).toEqual({
          name: "rpc",
          status: "ok",
          detail: "block 9",
        });
      });
    });
  });

  it("includes --home in the missing-profile hint only when the flag was given", async () => {
    await withTempDir(async (home) => {
      const flagged = fakeIo({
        worldChainBlock: async () => ({ number: 1n, timestamp: 1n }),
      });
      expect(await run(["doctor", "--home", home], flagged.io)).toBe(1);
      expect(
        flagged.out.some((line) =>
          line.includes(`not found — run npx -y hors-cli connect --profile default --home ${home}`),
        ),
      ).toBe(true);
      const envOnly = fakeIo({
        env: { HORS_HOME: home },
        worldChainBlock: async () => ({ number: 1n, timestamp: 1n }),
      });
      await run(["doctor"], envOnly.io);
      expect(
        envOnly.out.some((line) =>
          line.includes("not found — run npx -y hors-cli connect --profile default"),
        ),
      ).toBe(true);
      expect(envOnly.out.join("\n")).not.toContain("--home");
    });
  });

  it("reports the mock identity and skips the live lookup when HORS_MOCK=1", async () => {
    await withTempDir(async (home) => {
      const record = await createProfile(home, "default");
      const mockId = MockAgentBook.humanIdOf(record.address);
      let looked = 0;
      const { io, out } = fakeIo({
        env: { HORS_MOCK: "1" },
        agentBook: {
          lookupHuman: async () => {
            looked += 1;
            return `0x${"b".repeat(64)}`;
          },
          getNextNonce: async () => 1n,
        },
        worldChainBlock: async () => ({ number: 1n, timestamp: 1n }),
      });
      expect(await run(["doctor", "--home", home], io)).toBe(0);
      expect(out.some((line) => line === `ok  identity: ${mockId} (mock)`)).toBe(true);
      expect(out.some((line) => line.startsWith("fail  registration:"))).toBe(false);
      expect(looked).toBe(0);
    });
  });
});
