import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { VERSION } from "../src/version.js";
import { fakeIo } from "./helpers/io.js";
import { withTempDir } from "./helpers/tmp.js";

describe("CLI flags and exit codes (T2)", () => {
  it("prints usage on stderr and exits 2 when there is no command", async () => {
    const { io, out, err } = fakeIo({});
    expect(await run([], io)).toBe(2);
    expect(out.join("")).not.toMatch(/Usage:/);
    expect(err.join("\n")).toMatch(/Usage:/);
  });

  it("exits 2 for an unknown command", async () => {
    const { io } = fakeIo({});
    expect(await run(["nope"], io)).toBe(2);
  });

  it("prints the package version and exits 0", async () => {
    const { io, out } = fakeIo({});
    expect(await run(["--version"], io)).toBe(0);
    expect(out.join("\n")).toContain(VERSION);
  });

  it("treats an invalid --profile as a usage error", async () => {
    const { io, err } = fakeIo({});
    expect(await run(["--profile", "../x", "status"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/invalid --profile|error:/);
  });

  it("exits 4 with the exact not-connected message when status has no profile", async () => {
    await withTempDir(async (home) => {
      const { io, err } = fakeIo({ env: { HORS_HOME: home } });
      expect(await run(["status", "--home", home], io)).toBe(4);
      expect(err).toContain(
        `error: not connected: run npx -y hors-cli connect --profile default --home ${home} in a visible terminal`,
      );
    });
  });

  it("does not add --home to the not-connected hint when only HORS_HOME is set", async () => {
    await withTempDir(async (home) => {
      const { io, err } = fakeIo({ env: { HORS_HOME: home } });
      expect(await run(["status"], io)).toBe(4);
      expect(err).toContain(
        "error: not connected: run npx -y hors-cli connect --profile default in a visible terminal",
      );
      expect(err.join("\n")).not.toContain("--home");
    });
  });

  it("prints JSON errors as { error: { code, message } }", async () => {
    await withTempDir(async (home) => {
      const { io, out, err } = fakeIo({ env: { HORS_HOME: home } });
      expect(await run(["--json", "status", "--home", home], io)).toBe(4);
      expect(JSON.parse(out[0] ?? "{}")).toEqual({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: `not connected: run npx -y hors-cli connect --profile default --home ${home} in a visible terminal`,
        },
      });
      expect(err.join("")).not.toContain("\u001b[");
    });
  });

  it("never emits ANSI under --json", async () => {
    const { io, out, err } = fakeIo({});
    await run(["--json", "--help"], io);
    expect(`${out.join("")}${err.join("")}`).not.toContain("\u001b[");
  });

  it("drops the next: line of init under --quiet but keeps the wrote line", async () => {
    await withTempDir(async (cwd) => {
      const { io, out } = fakeIo({ cwd });
      expect(await run(["init", "--quiet", "--profile", "svc"], io)).toBe(0);
      expect(out.some((line) => line.startsWith("wrote hors.config.ts"))).toBe(true);
      expect(out.some((line) => line.startsWith("next:"))).toBe(false);
    });
  });
});
