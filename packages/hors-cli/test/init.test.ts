import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "hors-sdk/node";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { deriveProfileName } from "../src/init-template.js";
import { fakeIo } from "./helpers/io.js";
import { withTempDir } from "./helpers/tmp.js";

// loadConfig import()s the generated hors.config.ts; Node cannot resolve hors-sdk from the OS temp dir.
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

describe("hors init (T3)", () => {
  it("derives My-Service- from @acme/My Service!", () => {
    expect(deriveProfileName("@acme/My Service!")).toBe("My-Service-");
  });

  it("uses the package.json name by default", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "@acme/My Service!" }));
      const { io, out } = fakeIo({ cwd });
      expect(await run(["init"], io)).toBe(0);
      expect(out[0]).toBe("wrote hors.config.ts (profile My-Service-)");
      const text = await readFile(join(cwd, "hors.config.ts"), "utf8");
      expect(text).toContain('import { defineConfig } from "hors-sdk"');
      expect(text).toContain('profile: "My-Service-"');
      const loaded = await loadConfig({ cwd, env: {}, configFile: false });
      expect(loaded.config.profile).toBe("default");
      const fromFile = await loadConfig({ cwd, env: {} });
      expect(fromFile.config.profile).toBe("My-Service-");
    }, pkgRoot);
  });

  it("uses the directory name when package.json has no name", async () => {
    await withTempDir(async (cwd) => {
      const { io, out } = fakeIo({ cwd });
      expect(await run(["init"], io)).toBe(0);
      const expected = deriveProfileName(cwd.split("/").pop() ?? "dir");
      expect(out[0]).toBe(`wrote hors.config.ts (profile ${expected})`);
    });
  });

  it("honours --profile and refuses to overwrite without --force", async () => {
    await withTempDir(async (cwd) => {
      const { io } = fakeIo({ cwd });
      expect(await run(["init", "--profile", "svc"], io)).toBe(0);
      expect(await run(["init", "--profile", "svc"], io)).toBe(1);
      expect(await run(["init", "--profile", "svc", "--force"], io)).toBe(0);
      const text = await readFile(join(cwd, "hors.config.ts"), "utf8");
      expect(text).toContain('profile: "svc"');
    });
  });

  it("ignores HORS_PROFILE when --profile is absent", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "from-package" }));
      const { io } = fakeIo({ cwd, env: { HORS_PROFILE: "other" } });
      expect(await run(["init"], io)).toBe(0);
      const text = await readFile(join(cwd, "hors.config.ts"), "utf8");
      expect(text).toContain('profile: "from-package"');
    });
  });

  it("honours --profile=x and --profile x over HORS_PROFILE", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "from-package" }));
      const equals = fakeIo({ cwd, env: { HORS_PROFILE: "other" } });
      expect(await run(["init", "--profile=equals-form"], equals.io)).toBe(0);
      expect(await readFile(join(cwd, "hors.config.ts"), "utf8")).toContain(
        'profile: "equals-form"',
      );
      const spaced = fakeIo({ cwd, env: { HORS_PROFILE: "other" } });
      expect(await run(["init", "--profile", "spaced-form", "--force"], spaced.io)).toBe(0);
      expect(await readFile(join(cwd, "hors.config.ts"), "utf8")).toContain(
        'profile: "spaced-form"',
      );
    });
  });

  it("includes --home in the next hint only when the flag was given", async () => {
    await withTempDir(async (cwd) => {
      await withTempDir(async (home) => {
        const flagged = fakeIo({ cwd });
        expect(await run(["init", "--profile", "svc", "--home", home], flagged.io)).toBe(0);
        expect(
          flagged.out.some(
            (line) => line === `next: npx -y hors-cli connect --profile svc --home ${home}`,
          ),
        ).toBe(true);
        const envOnly = fakeIo({ cwd, env: { HORS_HOME: home } });
        expect(await run(["init", "--profile", "svc", "--force"], envOnly.io)).toBe(0);
        expect(
          envOnly.out.some((line) => line === "next: npx -y hors-cli connect --profile svc"),
        ).toBe(true);
        expect(envOnly.out.join("\n")).not.toContain("--home");
      });
    });
  });
});
