import { describe, expect, it } from "vitest";
import { envLayer, logLevelFrom } from "../src/config/env.js";
import { HorsError } from "../src/errors.js";

describe("envLayer and logLevelFrom", () => {
  it("returns an empty layer when no HORS overrides are set", () => {
    expect(envLayer({})).toEqual({});
  });

  it("maps the four override variables and ignores everything else", () => {
    expect(
      envLayer({
        HORS_OWNER: "0xabc",
        HORS_PROFILE: "svc",
        HORS_WORLDCHAIN_RPC: "https://rpc",
        HORS_MOCK: "1",
        HORS_LOG: "debug",
        HORS_HOME: "/x",
        PATH: "/bin",
      }),
    ).toEqual({
      owner: "0xabc",
      profile: "svc",
      rpc: { worldchain: "https://rpc" },
      dev: { mockOrigin: true },
    });
  });

  it.each(["0", "true", ""] as const)("ignores HORS_MOCK=%s", (value) => {
    expect(envLayer({ HORS_MOCK: value })).toEqual({});
  });

  it("ignores empty HORS_OWNER", () => {
    expect(envLayer({ HORS_OWNER: "" })).toEqual({});
  });

  it("defaults HORS_LOG to info", () => {
    expect(logLevelFrom({})).toBe("info");
    expect(logLevelFrom({ HORS_LOG: "" })).toBe("info");
  });

  it.each(["silent", "error", "info", "debug"] as const)("accepts HORS_LOG=%s", (level) => {
    expect(logLevelFrom({ HORS_LOG: level })).toBe(level);
  });

  it.each(["warn", "INFO", "1"] as const)("rejects HORS_LOG=%s", (value) => {
    try {
      logLevelFrom({ HORS_LOG: value });
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("CONFIG_INVALID");
      expect((error as HorsError).message).toBe(
        "HORS_LOG must be one of silent, error, info, debug",
      );
      return;
    }
    expect.unreachable();
  });
});
