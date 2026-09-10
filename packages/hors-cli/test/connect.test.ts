import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createProfile, readProfile, writeProfile } from "hors-sdk/node";
import { MockAgentBook } from "hors-sdk/world";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { WORLD_CLI } from "../src/register.js";
import { blob, fakeIo } from "./helpers/io.js";
import { HUMAN_B, overrideBook, pinProfile } from "./helpers/profile.js";
import { withTempDir } from "./helpers/tmp.js";

describe("hors connect (T6)", () => {
  it("creates the profile then refuses registration without a TTY", async () => {
    await withTempDir(async (home) => {
      const { io, err } = fakeIo({ isTTY: false });
      expect(await run(["connect", "--home", home], io)).toBe(1);
      expect(err.join("\n")).toContain("hors connect needs a terminal");
      const key = (await readFile(join(home, "default", "key"), "utf8")).trim();
      expect(await run(["connect", "--home", home], io)).toBe(1);
      expect((await readFile(join(home, "default", "key"), "utf8")).trim()).toBe(key);
    });
  });

  it("creates only the profile with --no-register and needs no TTY", async () => {
    await withTempDir(async (home) => {
      const { io, out } = fakeIo({ isTTY: false });
      expect(await run(["connect", "--no-register", "--home", home], io)).toBe(0);
      expect(out).toContain(
        `next: npx -y hors-cli connect --profile default --home ${home} (in a terminal)`,
      );
      expect(await readProfile(home, "default")).toMatchObject({
        address: expect.stringMatching(/^0x/),
      });
    });
  });

  it("pins a humanId after a fake World CLI registration", async () => {
    await withTempDir(async (home) => {
      const book = overrideBook();
      const { io, out, spawns } = fakeIo({
        isTTY: true,
        agentBook: book,
        spawnResult: () => {
          book.nonce = 2n;
          return 0;
        },
      });
      expect(await run(["connect", "--home", home], io)).toBe(0);
      const record = await readProfile(home, "default");
      expect(record?.humanId).toBe(MockAgentBook.humanIdOf(record?.address ?? "0x0"));
      expect(record?.registeredAt).toEqual(expect.stringMatching(/^\d{4}-/));
      expect(out.some((line) => line.startsWith("connected:"))).toBe(true);
      expect(spawns[0]).toEqual({
        command: process.platform === "win32" ? "npx.cmd" : "npx",
        args: ["-y", WORLD_CLI, "register", record?.address],
      });
    });
  });

  it("fails when the nonce never moves, even if spawn exits 0", async () => {
    await withTempDir(async (home) => {
      let t = 0;
      const { io, err } = fakeIo({
        isTTY: true,
        agentBook: overrideBook(),
        spawnResult: 0,
        now: () => {
          t += 10_000;
          return t;
        },
      });
      expect(await run(["connect", "--home", home], io)).toBe(1);
      expect(err.join("\n")).toContain("registration did not land on World Chain within 120 s");
      expect(await readProfile(home, "default")).not.toHaveProperty("humanId");
    });
  });

  it("is a no-op when the pin already matches live", async () => {
    await withTempDir(async (home) => {
      const record = await pinProfile(home);
      const { io, out, spawns } = fakeIo({ isTTY: true, agentBook: new MockAgentBook() });
      expect(await run(["connect", "--home", home], io)).toBe(0);
      expect(spawns).toEqual([]);
      expect(out).toContain(`connected: ${record.humanId}`);
    });
  });

  it("offers re-registration when the pin does not match", async () => {
    await withTempDir(async (home) => {
      const record = await pinProfile(home);
      const noBook = overrideBook([[record.address, HUMAN_B]]);
      const declined = fakeIo({ isTTY: true, agentBook: noBook, confirmAnswers: [false] });
      expect(await run(["connect", "--home", home], declined.io)).toBe(1);
      expect(declined.spawns).toEqual([]);

      const yesBook = overrideBook([[record.address, HUMAN_B]]);
      const accepted = fakeIo({
        isTTY: true,
        agentBook: yesBook,
        confirmAnswers: [true],
        spawnResult: () => {
          yesBook.nonce = 2n;
          yesBook.set(record.address, MockAgentBook.humanIdOf(record.address));
          return 0;
        },
      });
      expect(await run(["connect", "--home", home], accepted.io)).toBe(0);
      expect(accepted.spawns.length).toBe(1);
      expect((await readProfile(home, "default"))?.humanId).toBe(
        MockAgentBook.humanIdOf(record.address),
      );
    });
  });

  it("warns when another profile belongs to a different human", async () => {
    await withTempDir(async (home) => {
      const other = await createProfile(home, "other");
      await writeProfile(home, "other", {
        ...other,
        humanId: HUMAN_B,
        registeredAt: "2026-01-01T00:00:00.000Z",
      });
      const book = overrideBook();
      const { io, err } = fakeIo({
        isTTY: true,
        agentBook: book,
        spawnResult: () => {
          book.nonce = 2n;
          return 0;
        },
      });
      expect(await run(["connect", "--home", home], io)).toBe(0);
      expect(err.join("\n")).toContain("warning: profile other belongs to a different human");
    });
  });

  it("never prints the private key (C4)", async () => {
    await withTempDir(async (home) => {
      const { io, out, err } = fakeIo({ isTTY: false });
      await run(["connect", "--no-register", "--home", home, "--json"], io);
      const key = (await readFile(join(home, "default", "key"), "utf8")).trim();
      expect(blob(out, err)).not.toContain(key);
      expect(blob(out, err)).not.toContain(key.slice(2));
    });
  });

  it("omits --home from the next hint when only HORS_HOME is set", async () => {
    await withTempDir(async (home) => {
      const { io, out } = fakeIo({ isTTY: false, env: { HORS_HOME: home } });
      expect(await run(["connect", "--no-register"], io)).toBe(0);
      expect(out).toContain("next: npx -y hors-cli connect --profile default (in a terminal)");
      expect(out.join("\n")).not.toContain("--home");
    });
  });
});
