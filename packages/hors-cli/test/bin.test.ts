import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

describe("hors bin (T10)", () => {
  it.skipIf(!existsSync(bin))(
    "prints --version and exits 2 with no command (needs pnpm build)",
    async () => {
      const version = await exec(process.execPath, [bin, "--version"]);
      expect(version.stdout.trim()).toBe(VERSION);
      try {
        await exec(process.execPath, [bin]);
        expect.unreachable();
      } catch (error) {
        const result = error as { code: number; stderr: string };
        expect(result.code).toBe(2);
      }
    },
  );
});
