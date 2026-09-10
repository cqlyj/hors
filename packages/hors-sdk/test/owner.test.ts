import { describe, expect, it, vi } from "vitest";
import type { ProfileRecord } from "../src/config/profile.js";
import { HorsError } from "../src/errors.js";
import { createOwnerResolver, gateAddress, type OwnerSource } from "../src/gate/owner.js";
import { isAddress } from "../src/identity.js";
import { MockAgentBook } from "../src/world/mock.js";
import { ADDR_A, HUMAN_A } from "./helpers/context.js";
import { memoryLogger } from "./helpers/logger.js";

const PROFILE: ProfileRecord = { address: ADDR_A, humanId: HUMAN_A };
const UNRESOLVED =
  "HORS owner unresolved: remote same-human calls are denied until the profile is connected";

function source(overrides: Partial<OwnerSource> = {}): OwnerSource {
  return {
    configured: "auto",
    mock: false,
    address: ADDR_A,
    profile: { home: "/h", name: "svc" },
    initial: undefined,
    ...overrides,
  };
}

describe("owner resolver and gateAddress", () => {
  it("returns an explicit owner forever without reading or logging", async () => {
    const { log, events } = memoryLogger();
    const read = vi.fn();
    const resolver = createOwnerResolver(source({ configured: HUMAN_A }), {
      readProfile: read,
      log,
    });
    expect(resolver.current()).toBe(HUMAN_A);
    expect(await resolver.resolve(0)).toBe(HUMAN_A);
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    const mocked = createOwnerResolver(source({ configured: HUMAN_A, mock: true }), {
      readProfile: read,
      log,
    });
    expect(mocked.current()).toBe(HUMAN_A);
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("computes a mock owner from the gate address", () => {
    const { log, events } = memoryLogger();
    const read = vi.fn();
    const resolver = createOwnerResolver(source({ mock: true }), { readProfile: read, log });
    expect(resolver.current()).toBe(MockAgentBook.humanIdOf(ADDR_A));
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("stays unresolved in mock mode when there is no address", () => {
    const { log, events } = memoryLogger();
    const resolver = createOwnerResolver(source({ mock: true, address: null }), {
      readProfile: vi.fn(),
      log,
    });
    expect(resolver.current()).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe(UNRESOLVED);
  });

  it("uses the pinned humanId from the initial profile", async () => {
    const { log, events } = memoryLogger();
    const read = vi.fn();
    const resolver = createOwnerResolver(source({ initial: PROFILE }), { readProfile: read, log });
    expect(resolver.current()).toBe(HUMAN_A);
    expect(await resolver.resolve(0)).toBe(HUMAN_A);
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("logs the unresolved-owner warning once at construction", () => {
    const { log, events } = memoryLogger();
    for (const initial of [undefined, { address: ADDR_A, humanId: undefined }]) {
      events.length = 0;
      const resolver = createOwnerResolver(source({ initial }), { readProfile: vi.fn(), log });
      expect(resolver.current()).toBeNull();
      expect(events).toEqual([
        expect.objectContaining({
          level: "error",
          message: UNRESOLVED,
          data: expect.objectContaining({
            fix: "hors connect --profile svc",
            alternative: "set HORS_OWNER to the value of hors whoami",
            profile: expect.stringMatching(/svc[/\\]profile\.json$/),
          }),
        }),
      ]);
    }
  });

  it("re-reads the profile at most once per 10 seconds while unresolved", async () => {
    const { log } = memoryLogger();
    const read = vi.fn(async () => undefined);
    const resolver = createOwnerResolver(source(), { readProfile: read, log });
    expect(await resolver.resolve(1_000)).toBeNull();
    expect(await resolver.resolve(10_999)).toBeNull();
    expect(await resolver.resolve(11_000)).toBeNull();
    expect(await resolver.resolve(11_001)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not close the recheck window when now is non-finite", async () => {
    const { log } = memoryLogger();
    const read = vi.fn(async () => undefined);
    const resolver = createOwnerResolver(source(), { readProfile: read, log });
    expect(await resolver.resolve(Number.POSITIVE_INFINITY)).toBeNull();
    expect(await resolver.resolve(20_000)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("resolves permanently when a later read yields a humanId", async () => {
    const { log, events } = memoryLogger();
    const read = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(PROFILE);
    const resolver = createOwnerResolver(source(), { readProfile: read, log });
    expect(await resolver.resolve(0)).toBeNull();
    expect(await resolver.resolve(10_000)).toBe(HUMAN_A);
    expect(resolver.current()).toBe(HUMAN_A);
    expect(await resolver.resolve(50_000)).toBe(HUMAN_A);
    expect(read).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.message === "HORS owner resolved")).toEqual([
      expect.objectContaining({
        level: "info",
        message: "HORS owner resolved",
      }),
    ]);
  });

  it("swallows a thrown profile read and stays unresolved", async () => {
    const { log, events } = memoryLogger();
    const message = "profile.json is not valid JSON: /p";
    const read = vi.fn(async () => {
      throw new HorsError("CONFIG_INVALID", message);
    });
    const resolver = createOwnerResolver(source(), { readProfile: read, log });
    await expect(resolver.resolve(0)).resolves.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "profile.json is invalid",
        data: expect.objectContaining({ message }),
      }),
    );
  });

  it("derives the gate address from a private key, profile, or ephemeral mock key", () => {
    const { log, events } = memoryLogger();
    const key = `0x${"1".repeat(64)}`;
    expect(
      gateAddress({
        privateKey: key,
        profile: { address: ADDR_A, humanId: HUMAN_A },
        mock: false,
        log,
      }),
    ).toBe("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a");
    expect(events).toEqual([]);

    for (const privateKey of ["0x12", "1".repeat(64), `0x${"g".repeat(64)}`]) {
      try {
        gateAddress({ privateKey, profile: undefined, mock: false, log });
      } catch (error) {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        expect((error as HorsError).message).not.toContain("1111");
        continue;
      }
      expect.unreachable();
    }

    expect(gateAddress({ privateKey: undefined, profile: PROFILE, mock: false, log })).toBe(
      PROFILE.address,
    );
    expect(gateAddress({ privateKey: undefined, profile: undefined, mock: false, log })).toBeNull();
    expect(events).toEqual([]);

    const first = gateAddress({ privateKey: undefined, profile: undefined, mock: true, log });
    const second = gateAddress({ privateKey: undefined, profile: undefined, mock: true, log });
    expect(first).not.toBe(second);
    expect(first).toHaveLength(42);
    expect(second).toHaveLength(42);
    expect(isAddress(first)).toBe(true);
    expect(isAddress(second)).toBe(true);
    expect(events.filter((event) => event.message.startsWith("HORS mock mode"))).toHaveLength(2);
    expect(events[0]?.data?.address).toBe(first);

    for (const privateKey of [
      `0x${"0".repeat(64)}`,
      `0x${"f".repeat(64)}`,
      "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
    ]) {
      try {
        gateAddress({ privateKey, profile: undefined, mock: false, log });
      } catch (error) {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        expect((error as HorsError).message).toContain(
          "HORS_PRIVATE_KEY must be a valid secp256k1 private key",
        );
        expect((error as HorsError).message).not.toContain("115792");
        expect((error as HorsError).message).not.toContain("got");
        expect((error as HorsError).cause).toBeUndefined();
        continue;
      }
      expect.unreachable();
    }
  });
});
