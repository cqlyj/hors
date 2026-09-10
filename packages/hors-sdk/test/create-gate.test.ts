import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGate } from "../src/gate/gate.js";
import { isAddress } from "../src/identity.js";
import { MockAgentBook } from "../src/world/mock.js";
import { withTempDir } from "./helpers/tmp.js";

describe("createGate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds a mock gate, honours configFile, and never writes stdout", async () => {
    await withTempDir(async (dir) => {
      vi.stubEnv("HORS_HOME", dir);
      vi.stubEnv("HORS_MOCK", "1");
      vi.stubEnv("HORS_LOG", "silent");
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      const stdout = vi.spyOn(process.stdout, "write");

      const gate = await createGate();
      expect(isAddress(gate.address)).toBe(true);
      expect(gate.owner()).toBe(MockAgentBook.humanIdOf(gate.address as `0x${string}`));

      await writeFile(path.join(dir, "hors.config.json"), '{"policy":"public"}\n');
      const fromFile = await createGate();
      expect(fromFile.policyFor("x").name).toBe("public");

      const skipped = await createGate({ configFile: false });
      expect(skipped.policyFor("x").name).toBe("same-human");

      await writeFile(path.join(dir, "other.json"), '{"policy":"any-human"}\n');
      const other = await createGate({ configFile: "other.json" });
      expect(other.policyFor("x").name).toBe("any-human");

      vi.stubEnv("NODE_ENV", "production");
      await expect(createGate()).rejects.toSatisfy((error) => {
        expect((error as { code?: string }).code).toBe("CONFIG_INVALID");
        return true;
      });

      expect(stdout).not.toHaveBeenCalled();
    });
  });
});
