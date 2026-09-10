import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { profileHome, profilePath, readProfile } from "../src/config/profile.js";
import { HorsError } from "../src/errors.js";
import { normalizeAddress, normalizeHumanId } from "../src/identity.js";
import { withTempDir } from "./helpers/tmp.js";

async function expectConfigInvalid(
  run: () => Promise<unknown>,
  substring: string,
): Promise<HorsError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("CONFIG_INVALID");
    expect((error as HorsError).message).toContain(substring);
    return error as HorsError;
  }
  expect.unreachable();
}

describe("profile paths and readProfile", () => {
  it("resolves HORS_HOME or the default ~/.hors directory", () => {
    expect(profileHome({ HORS_HOME: "/x" })).toBe("/x");
    expect(profileHome({ HORS_HOME: "" })).toBe(path.join(os.homedir(), ".hors"));
    const fallback = profileHome({});
    expect(fallback.startsWith(os.homedir())).toBe(true);
    expect(fallback.endsWith(`${path.sep}.hors`) || fallback.endsWith("/.hors")).toBe(true);
  });

  it("joins home, name and profile.json", () => {
    expect(profilePath("/h", "svc")).toBe(path.join("/h", "svc", "profile.json"));
  });

  it("returns undefined when the profile directory or file is missing", async () => {
    await withTempDir(async (home) => {
      expect(await readProfile(home, "svc")).toBeUndefined();
      await mkdir(path.join(home, "svc"));
      expect(await readProfile(home, "svc")).toBeUndefined();
    });
  });

  it("reads address and humanId and ignores extra keys", async () => {
    await withTempDir(async (home) => {
      await mkdir(path.join(home, "svc"));
      await writeFile(
        path.join(home, "svc", "profile.json"),
        JSON.stringify({
          address: "0xAbC0000000000000000000000000000000000001",
          humanId: "0xABC",
          createdAt: "2026-01-01T00:00:00Z",
          label: "x",
          extra: true,
        }),
      );
      expect(await readProfile(home, "svc")).toEqual({
        address: normalizeAddress("0xAbC0000000000000000000000000000000000001"),
        humanId: normalizeHumanId("0xABC"),
        createdAt: "2026-01-01T00:00:00Z",
        label: "x",
      });
    });
  });

  it("treats a missing humanId as unpinned", async () => {
    await withTempDir(async (home) => {
      await mkdir(path.join(home, "svc"));
      await writeFile(
        path.join(home, "svc", "profile.json"),
        JSON.stringify({ address: "0xAbC0000000000000000000000000000000000001" }),
      );
      expect((await readProfile(home, "svc"))?.humanId).toBeUndefined();
    });
  });

  it("rejects invalid JSON, objects, addresses and humanIds", async () => {
    await withTempDir(async (home) => {
      await mkdir(path.join(home, "svc"));
      const file = path.join(home, "svc", "profile.json");
      await writeFile(file, "{");
      const invalidJson = await expectConfigInvalid(
        () => readProfile(home, "svc"),
        "profile.json is not valid JSON",
      );
      expect(invalidJson.message).toContain(file);

      await writeFile(file, "[]");
      await expectConfigInvalid(() => readProfile(home, "svc"), "profile.json must be an object");

      await writeFile(file, "{}");
      await expectConfigInvalid(
        () => readProfile(home, "svc"),
        "profile.json has an invalid address",
      );

      await writeFile(file, JSON.stringify({ address: "0x12" }));
      await expectConfigInvalid(
        () => readProfile(home, "svc"),
        "profile.json has an invalid address",
      );

      await writeFile(
        file,
        JSON.stringify({
          address: "0xAbC0000000000000000000000000000000000001",
          humanId: "0x0",
        }),
      );
      await expectConfigInvalid(
        () => readProfile(home, "svc"),
        "profile.json has an invalid humanId",
      );

      await writeFile(
        file,
        JSON.stringify({
          address: "0xAbC0000000000000000000000000000000000001",
          humanId: null,
        }),
      );
      await expectConfigInvalid(
        () => readProfile(home, "svc"),
        "profile.json has an invalid humanId",
      );
    });
  });

  it("rejects a profile name that would leave home", async () => {
    await withTempDir(async (parent) => {
      const home = path.join(parent, "home");
      const outside = path.join(parent, "x");
      await mkdir(home);
      await mkdir(outside);
      await writeFile(
        path.join(outside, "profile.json"),
        JSON.stringify({
          address: "0xAbC0000000000000000000000000000000000001",
          humanId: "0xABC",
        }),
      );
      await expectConfigInvalid(() => readProfile(home, "../x"), "profile name is invalid");
    });
  });

  it("rejects a directory or oversized file at the profile path", async () => {
    await withTempDir(async (home) => {
      await mkdir(path.join(home, "svc", "profile.json"), { recursive: true });
      const dirError = await expectConfigInvalid(
        () => readProfile(home, "svc"),
        "profile.json is not a regular file",
      );
      expect(dirError.message).toContain(path.join(home, "svc", "profile.json"));

      await withTempDir(async (other) => {
        await mkdir(path.join(other, "svc"));
        const file = path.join(other, "svc", "profile.json");
        await writeFile(file, "x".repeat(1_048_577));
        const sizeError = await expectConfigInvalid(
          () => readProfile(other, "svc"),
          "profile.json exceeds 1 MiB",
        );
        expect(sizeError.message).toContain(file);
      });
    });
  });

  it("strips a leading BOM from a valid profile.json", async () => {
    await withTempDir(async (home) => {
      await mkdir(path.join(home, "svc"));
      await writeFile(
        path.join(home, "svc", "profile.json"),
        `\uFEFF${JSON.stringify({
          address: "0xAbC0000000000000000000000000000000000001",
          humanId: "0xABC",
        })}`,
      );
      expect(await readProfile(home, "svc")).toEqual({
        address: normalizeAddress("0xAbC0000000000000000000000000000000000001"),
        humanId: normalizeHumanId("0xABC"),
      });
    });
  });

  it.skipIf(process.getuid?.() === 0)("rejects an unreadable profile.json", async () => {
    await withTempDir(async (home) => {
      await mkdir(path.join(home, "svc"));
      const file = path.join(home, "svc", "profile.json");
      await writeFile(file, "{}");
      await chmod(file, 0o000);
      try {
        await expectConfigInvalid(() => readProfile(home, "svc"), "profile.json is not readable");
      } finally {
        await chmod(file, 0o644);
      }
    });
  });
});
