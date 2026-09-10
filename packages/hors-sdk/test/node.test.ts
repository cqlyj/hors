import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createProfile,
  deleteProfile,
  loadConfig,
  PROFILE_NAME,
  profileHome,
  readAddressBook,
  readProfile,
  writeAddressBook,
  writeProfile,
} from "../src/node/index.js";
import { withTempDir } from "./helpers/tmp.js";

describe("hors-sdk/node", () => {
  it("exports the node entry-point names", async () => {
    const mod = await import("../src/node/index.js");
    expect(Object.keys(mod).sort()).toEqual([
      "PROFILE_NAME",
      "createProfile",
      "deleteProfile",
      "loadConfig",
      "profileHome",
      "readAddressBook",
      "readKeyFile",
      "readProfile",
      "writeAddressBook",
      "writeProfile",
    ]);
    expect(PROFILE_NAME.test("default")).toBe(true);
    expect(profileHome({ HORS_HOME: "/x" })).toBe("/x");
  });

  it("creates a profile with 0700/0600 and refuses a second create", async () => {
    await withTempDir(async (home) => {
      const record = await createProfile(home, "agent", { label: "ok" });
      expect(record.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(record.label).toBe("ok");
      expect(record.createdAt).toEqual(expect.stringMatching(/^\d{4}-/));
      expect(record).not.toHaveProperty("humanId");
      const dir = await stat(join(home, "agent"));
      const key = await stat(join(home, "agent", "key"));
      if (process.platform !== "win32") {
        expect(dir.mode & 0o777).toBe(0o700);
        expect(key.mode & 0o777).toBe(0o600);
      }
      const hex = (await readFile(join(home, "agent", "key"), "utf8")).trim();
      expect(JSON.stringify(record)).not.toContain(hex.slice(2));
      await expect(createProfile(home, "agent")).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("already exists"),
      });
    });
  });

  it("rejects an invalid name or label on create", async () => {
    await withTempDir(async (home) => {
      await expect(createProfile(home, "../x")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(createProfile(home, "ok", { label: "x".repeat(201) })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      await expect(createProfile(home, "ok", { label: "bad\nlabel" })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
    });
  });

  it("writes a profile atomically and reads it leniently", async () => {
    await withTempDir(async (home) => {
      const created = await createProfile(home, "agent");
      await writeProfile(home, "agent", {
        ...created,
        humanId: "0xabc",
        registeredAt: "2026-01-01T00:00:00.000Z",
      });
      const extra = JSON.parse(await readFile(join(home, "agent", "profile.json"), "utf8"));
      extra.foo = 1;
      delete extra.createdAt;
      await writeFile(join(home, "agent", "profile.json"), JSON.stringify(extra));
      const read = await readProfile(home, "agent");
      expect(read?.humanId).toBe(`0x${"0".repeat(61)}abc`);
      expect(read?.createdAt).toBeUndefined();
      expect(read).not.toHaveProperty("foo");
      await writeFile(
        join(home, "agent", "profile.json"),
        JSON.stringify({ address: created.address, label: 1 }),
      );
      await expect(readProfile(home, "agent")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });
  });

  it("deletes only the profile directory", async () => {
    await withTempDir(async (home) => {
      await createProfile(home, "agent");
      await writeAddressBook(home, { work: "https://work.example/mcp" });
      await mkdir(join(home, "cache"), { recursive: true });
      await writeFile(join(home, "cache", "keep"), "1");
      await deleteProfile(home, "agent");
      await expect(stat(join(home, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readAddressBook(home)).toEqual({ work: "https://work.example/mcp" });
      expect(await readFile(join(home, "cache", "keep"), "utf8")).toBe("1");
    });
  });

  it("writes a sorted 0600 address book and rejects non-strings", async () => {
    await withTempDir(async (home) => {
      await writeAddressBook(home, { zed: "https://z.example", alpha: "https://a.example" });
      const text = await readFile(join(home, "services.json"), "utf8");
      expect(Object.keys(JSON.parse(text))).toEqual(["alpha", "zed"]);
      if (process.platform !== "win32") {
        expect((await stat(join(home, "services.json"))).mode & 0o777).toBe(0o600);
      }
      await expect(writeAddressBook(home, { x: 1 as unknown as string })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
    });
  });

  it("loadConfig returns the discovered path or undefined", async () => {
    await withTempDir(async (cwd) => {
      const none = await loadConfig({ cwd, env: {}, configFile: false });
      expect(none.path).toBeUndefined();
      await writeFile(join(cwd, "hors.config.json"), JSON.stringify({ policy: "public" }));
      const found = await loadConfig({ cwd, env: {} });
      expect(found.path).toBe(join(cwd, "hors.config.json"));
      expect(found.config.policy.name).toBe("public");
    });
  });
});
