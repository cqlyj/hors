import { access } from "node:fs/promises";
import { join } from "node:path";
import { MockAgentBook } from "hors-sdk/world";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { fakeIo } from "./helpers/io.js";
import { HUMAN_B, overrideBook, pinProfile } from "./helpers/profile.js";
import { withTempDir } from "./helpers/tmp.js";

describe("status / whoami / disconnect (T5)", () => {
  it("prints the six status lines for a connected profile", async () => {
    await withTempDir(async (home) => {
      const record = await pinProfile(home);
      const { io, out } = fakeIo({ agentBook: new MockAgentBook() });
      expect(await run(["status", "--home", home], io)).toBe(0);
      expect(out).toEqual([
        "profile  default",
        `address  ${record.address}`,
        `humanId  ${record.humanId}`,
        `live  ${record.humanId}`,
        "config  none",
        "mock  off",
      ]);
    });
  });

  it("warns and exits 1 when the pin no longer matches live", async () => {
    await withTempDir(async (home) => {
      const record = await pinProfile(home);
      const { io, err } = fakeIo({ agentBook: overrideBook([[record.address, HUMAN_B]]) });
      expect(await run(["status", "--home", home], io)).toBe(1);
      expect(err.join("\n")).toContain(
        "warning: on-chain registration for " +
          `${record.address} no longer matches the pinned humanId; someone may have re-registered this wallet. Fix: npx -y hors-cli connect --profile default --home ${home}`,
      );
    });
  });

  it("exits 4 when the profile has no pin", async () => {
    await withTempDir(async (home) => {
      const { createProfile } = await import("hors-sdk/node");
      await createProfile(home, "default");
      const { io, err } = fakeIo({});
      expect(await run(["status", "--home", home], io)).toBe(4);
      expect(err[0]).toContain(
        `not connected: run npx -y hors-cli connect --profile default --home ${home}`,
      );
    });
  });

  it("prints only the humanId for whoami", async () => {
    await withTempDir(async (home) => {
      const record = await pinProfile(home);
      const { io, out } = fakeIo({});
      expect(await run(["whoami", "--home", home], io)).toBe(0);
      expect(out).toEqual([record.humanId]);
    });
  });

  it("requires a TTY or --yes to disconnect", async () => {
    await withTempDir(async (home) => {
      const record = await pinProfile(home);
      const noTty = fakeIo({ isTTY: false });
      expect(await run(["disconnect", "--home", home], noTty.io)).toBe(2);
      const declined = fakeIo({ isTTY: true, confirmAnswers: [false] });
      expect(await run(["disconnect", "--home", home], declined.io)).toBe(1);
      const yes = fakeIo({ isTTY: false });
      expect(await run(["disconnect", "--yes", "--home", home], yes.io)).toBe(0);
      expect(yes.err[0]).toBe(`deleting profile default (${record.address})`);
      expect(yes.out[0]).toBe("deleted default");
      await expect(access(join(home, "default"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("prints profile lines then live unavailable when the RPC fails", async () => {
    await withTempDir(async (home) => {
      const record = await pinProfile(home);
      const { io, out, err } = fakeIo({
        agentBook: {
          lookupHuman: async () => {
            throw new Error("econnrefused");
          },
          getNextNonce: async () => 1n,
        },
      });
      expect(await run(["status", "--home", home], io)).toBe(1);
      expect(out).toEqual([
        "profile  default",
        `address  ${record.address}`,
        `humanId  ${record.humanId}`,
        "live  unavailable (econnrefused)",
        "config  none",
        "mock  off",
      ]);
      expect(err).toEqual([]);
    });
  });

  it("honours --home and does not touch the real ~/.hors", async () => {
    await withTempDir(async (home) => {
      await pinProfile(home);
      const { io } = fakeIo({ env: { HORS_HOME: "/should-not-use" } });
      expect(await run(["whoami", "--home", home], io)).toBe(0);
    });
  });

  it("prints the mock humanId for an unpinned profile when HORS_MOCK=1", async () => {
    await withTempDir(async (home) => {
      const { createProfile } = await import("hors-sdk/node");
      const record = await createProfile(home, "default");
      const mockId = MockAgentBook.humanIdOf(record.address);
      const { io, out, err } = fakeIo({ env: { HORS_MOCK: "1" } });
      expect(await run(["whoami", "--home", home], io)).toBe(0);
      expect(out).toEqual([mockId]);
      expect(err).toContain("warning: mock identity (HORS_MOCK)");
      const json = fakeIo({ env: { HORS_MOCK: "1" } });
      expect(await run(["whoami", "--home", home, "--json"], json.io)).toBe(0);
      expect(JSON.parse(json.out[0] ?? "{}")).toEqual({ humanId: mockId, mock: true });
    });
  });

  it("prints the mock humanId for whoami even when the profile is pinned", async () => {
    await withTempDir(async (home) => {
      const { writeProfile } = await import("hors-sdk/node");
      const record = await pinProfile(home);
      // A real pin differs from the mock id; mock mode must ignore it.
      await writeProfile(home, "default", { ...record, humanId: HUMAN_B });
      const mockId = MockAgentBook.humanIdOf(record.address);
      const { io, out, err } = fakeIo({ env: { HORS_MOCK: "1" } });
      expect(await run(["whoami", "--home", home], io)).toBe(0);
      expect(out).toEqual([mockId]);
      expect(err).toContain("warning: mock identity (HORS_MOCK)");
      const plain = fakeIo({ agentBook: new MockAgentBook() });
      expect(await run(["whoami", "--home", home], plain.io)).toBe(0);
      expect(plain.out).toEqual([HUMAN_B]);
    });
  });

  it("omits live lookup and hijack in mock status", async () => {
    await withTempDir(async (home) => {
      const { createProfile } = await import("hors-sdk/node");
      const record = await createProfile(home, "default");
      const mockId = MockAgentBook.humanIdOf(record.address);
      let looked = 0;
      const { io, out } = fakeIo({
        env: { HORS_MOCK: "1" },
        agentBook: {
          lookupHuman: async () => {
            looked += 1;
            return HUMAN_B;
          },
          getNextNonce: async () => 1n,
        },
      });
      expect(await run(["status", "--home", home], io)).toBe(0);
      expect(out).toEqual([
        "profile  default",
        `address  ${record.address}`,
        `humanId  ${mockId} (mock)`,
        "config  none",
        "mock  on",
      ]);
      expect(looked).toBe(0);
      const json = fakeIo({ env: { HORS_MOCK: "1" } });
      expect(await run(["status", "--home", home, "--json"], json.io)).toBe(0);
      expect(JSON.parse(json.out[0] ?? "{}")).toEqual({
        profile: "default",
        address: record.address,
        humanId: mockId,
        connected: true,
        config: null,
        mock: true,
      });
    });
  });
});
