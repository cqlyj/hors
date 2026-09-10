import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/schema.js";
import { HorsError } from "../src/errors.js";
import { buildGate } from "../src/gate/gate.js";
import { hashArgs } from "../src/hash.js";
import { isAddress, normalizeAddress } from "../src/identity.js";
import { compilePolicy } from "../src/policy/registry.js";
import type { HorsContext } from "../src/policy/types.js";
import { MockAgentBook } from "../src/world/mock.js";
import { HUMAN_A } from "./helpers/context.js";
import { memoryLogger } from "./helpers/logger.js";
import { WORK_URL } from "./helpers/pipeline.js";
import { DEFAULT_ARGS_HASH, signedEnvelope, testAccount } from "./helpers/sign.js";
import { withTempDir } from "./helpers/tmp.js";

const UNRESOLVED =
  "HORS owner unresolved: remote same-human calls are denied until the profile is connected";
const MOCK_LINE =
  "HORS mock mode: AgentBook is replaced by a deterministic mock; every wallet is its own fake human; refuse this in production";

async function writePinned(
  home: string,
  profile: { address: string; humanId?: string },
  name = "default",
): Promise<void> {
  await mkdir(path.join(home, name), { recursive: true });
  await writeFile(path.join(home, name, "profile.json"), JSON.stringify(profile));
}

describe("buildGate", () => {
  it("reads address and owner from a pinned profile", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      await writePinned(home, { address: account.address, humanId: HUMAN_A });
      const gate = await buildGate(
        validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }),
        {
          env: { HORS_HOME: home },
          log,
        },
      );
      expect(gate.address).toBe(normalizeAddress(account.address));
      expect(isAddress(gate.address)).toBe(true);
      // mock wins over the pin
      expect(gate.owner()).toBe(MockAgentBook.humanIdOf(normalizeAddress(account.address)));
    });
  });

  it("uses a pinned owner when mock is off", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const account = testAccount();
      await writePinned(home, { address: account.address, humanId: HUMAN_A });
      const gate = await buildGate(validateConfig({}, { nodeEnv: undefined }), {
        env: { HORS_HOME: home },
        log,
        agentBook: new MockAgentBook(),
      });
      expect(gate.owner()).toBe(HUMAN_A);
      expect(gate.address).toBe(normalizeAddress(account.address));
    });
  });

  it("warns once at construction and once on the first HORS_OWNER_UNRESOLVED", async () => {
    await withTempDir(async (home) => {
      const { log, events } = memoryLogger();
      const gate = await buildGate(
        validateConfig({ origins: ["https://work.example.com/mcp"] }, { nodeEnv: undefined }),
        { env: { HORS_HOME: home }, log, agentBook: new MockAgentBook() },
      );
      expect(gate.owner()).toBeNull();
      const account = testAccount();
      for (let i = 0; i < 3; i++) {
        const { raw } = await signedEnvelope(account, { fn: "f" });
        const decision = await gate.evaluate({
          fn: "f",
          argsHash: DEFAULT_ARGS_HASH,
          envelope: raw,
          transport: "http",
          local: false,
          url: WORK_URL,
        });
        expect(decision.ok).toBe(false);
        if (!decision.ok) {
          expect(decision.denial.code).toBe("HORS_OWNER_UNRESOLVED");
        }
      }
      expect(events.filter((event) => event.message === UNRESOLVED)).toHaveLength(2);
    });
  });

  it("logs the mock warning and stamps mock: true", async () => {
    await withTempDir(async (home) => {
      const { log, events } = memoryLogger();
      const gate = await buildGate(
        validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }),
        { env: { HORS_HOME: home }, log },
      );
      expect(events.some((event) => event.message === MOCK_LINE)).toBe(true);
      const address = gate.address;
      if (address === null) {
        expect.unreachable();
      }
      expect(gate.owner()).toBe(MockAgentBook.humanIdOf(address));
      expect(gate.mock).toBe(true);
      const decision = await gate.evaluate({
        fn: "f",
        argsHash: DEFAULT_ARGS_HASH,
        transport: "wrap",
        local: true,
      });
      expect(decision.ok && decision.result.mock).toBe(true);
    });
  });

  it("resolves policyFor by functions then the default (G3)", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const gate = await buildGate(
        validateConfig(
          {
            policy: "any-human",
            functions: JSON.parse(
              '{"approveTravelExpense":"public","constructor":"public","__proto__":"any-human","toString":"public"}',
            ),
            dev: { mockOrigin: true },
          },
          { nodeEnv: undefined },
        ),
        { env: { HORS_HOME: home }, log },
      );
      expect(gate.policyFor("approveTravelExpense").origin).toEqual(["public"]);
      expect(gate.policyFor("other").origin).toEqual(["any-human"]);
      expect(gate.policyFor("constructor").name).toBe("public");
      expect(gate.policyFor("__proto__").name).toBe("any-human");
      expect(gate.policyFor("toString").name).toBe("public");

      const bare = await buildGate(
        validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }),
        { env: { HORS_HOME: home }, log },
      );
      expect(bare.policyFor("x").name).toBe("same-human");
    });
  });

  it("publishes a redacted policy and reloads deny and functions", async () => {
    await withTempDir(async (home) => {
      const { log, events } = memoryLogger();
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      const gate = await buildGate(
        validateConfig(
          {
            functions: {
              f: { origin: [HUMAN_A, "same-human"], rule: () => true },
            },
            origins: ["https://work.example.com/mcp"],
            dev: { mockOrigin: true },
          },
          { nodeEnv: undefined },
        ),
        { env: { HORS_HOME: home, HORS_PRIVATE_KEY: key }, log },
      );
      const published = gate.publish("f");
      expect(published).toEqual({
        v: 1,
        origin: ["human", "same-human"],
        custom: true,
      });
      expect(JSON.stringify(published)).not.toContain(HUMAN_A.slice(2));

      const { raw } = await signedEnvelope(account, { fn: "f" });
      const before = await gate.evaluate({
        fn: "f",
        argsHash: DEFAULT_ARGS_HASH,
        envelope: raw,
        transport: "http",
        local: false,
        url: WORK_URL,
      });
      expect(before.ok).toBe(true);
      gate.reload({ deny: [account.address] });
      const after = await gate.evaluate({
        fn: "f",
        argsHash: DEFAULT_ARGS_HASH,
        envelope: (await signedEnvelope(account, { fn: "f" })).raw,
        transport: "http",
        local: false,
        url: WORK_URL,
      });
      expect(after.ok).toBe(false);
      if (!after.ok) {
        expect(after.denial.code).toBe("HORS_DENIED_WALLET");
      }

      const snapshot = gate.policyFor("g");
      expect(() => gate.reload({ nope: 1 } as never)).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
      expect(() => gate.reload({ deny: ["bad"] as never })).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
      expect(gate.policyFor("g")).toEqual(snapshot);

      gate.reload({ functions: { f: "public" } });
      expect(gate.policyFor("f").name).toBe("public");
      const unsigned = await gate.evaluate({
        fn: "f",
        argsHash: DEFAULT_ARGS_HASH,
        transport: "http",
        local: false,
      });
      expect(unsigned.ok).toBe(true);
      expect(events.some((event) => event.message === "HORS config reloaded")).toBe(true);
    });
  });

  it("wraps a handler, compiles policy at wrap time, and propagates errors", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      const gate = await buildGate(
        validateConfig(
          {
            origins: ["https://work.example.com/mcp"],
            functions: {
              paid: {
                origin: "public",
                use: async (ctx: HorsContext) =>
                  ctx.deny("no", { code: "OVER_BUDGET", challenge: { pay: 1 } }),
              },
            },
            dev: { mockOrigin: true },
          },
          { nodeEnv: undefined },
        ),
        { env: { HORS_HOME: home, HORS_PRIVATE_KEY: key }, log },
      );

      const pub = gate.wrap(
        "f",
        async (args, ctx) => ({ args, human: ctx.callerHumanId }),
        "public",
      );
      await expect(pub({ n: 1 })).resolves.toEqual({ args: { n: 1 }, human: null });

      const same = gate.wrap("f", async () => "ok");
      await expect(same({})).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("HORS_UNSIGNED");
        return true;
      });
      const args = { n: 1 };
      const { raw } = await signedEnvelope(account, { fn: "f", argsHash: await hashArgs(args) });
      await expect(same(args, raw)).resolves.toBe("ok");

      const paid = gate.wrap("paid", async () => "ok");
      await expect(paid({})).rejects.toSatisfy((error) => {
        expect((error as HorsError).code).toBe("OVER_BUDGET");
        expect((error as HorsError).message).toBe("no");
        expect((error as HorsError).data).toEqual({ challenge: { pay: 1 } });
        return true;
      });

      const db = new Error("db");
      const exploding = gate.wrap(
        "f",
        async () => {
          throw db;
        },
        "public",
      );
      await expect(exploding({})).rejects.toBe(db);

      expect(() => gate.wrap("f", async () => "ok", "no-such-policy")).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
      expect(() => gate.wrap("f", 1 as never)).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
      expect(() => gate.wrap("", async () => "ok")).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    });
  });

  it("subscribes audit listeners and rejects unknown events", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const gate = await buildGate(
        validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }),
        { env: { HORS_HOME: home }, log },
      );
      const seen: string[] = [];
      const off = gate.on("audit", (event) => {
        seen.push(event.fn);
      });
      await gate.evaluate({
        fn: "a",
        argsHash: DEFAULT_ARGS_HASH,
        transport: "wrap",
        local: true,
      });
      await gate.wrap("b", async () => "ok", "public")({});
      expect(seen).toEqual(["a", "b"]);
      off();
      expect(() => gate.on("other" as never, () => undefined)).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    });
  });

  it("fails fast on a corrupt profile and starts without a missing one", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      await mkdir(path.join(home, "default"), { recursive: true });
      await writeFile(path.join(home, "default", "profile.json"), "{");
      await expect(
        buildGate(validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }), {
          env: { HORS_HOME: home },
          log,
        }),
      ).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });

      await withTempDir(async (empty) => {
        const { log: emptyLog, events: emptyEvents } = memoryLogger();
        const gate = await buildGate(validateConfig({}, { nodeEnv: undefined }), {
          env: { HORS_HOME: empty },
          log: emptyLog,
          agentBook: new MockAgentBook(),
        });
        expect(gate.owner()).toBeNull();
        expect(emptyEvents.filter((event) => event.message === "HORS gate ready")).toEqual([
          expect.objectContaining({
            level: "info",
            message: "HORS gate ready",
            data: expect.objectContaining({
              profile: "default",
              mock: false,
              owner: "unresolved",
              configuredFunctions: [],
            }),
          }),
        ]);
      });
    });
  });

  it("compiles an inline wrap policy immediately", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const gate = await buildGate(
        validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }),
        { env: { HORS_HOME: home }, log },
      );
      expect(compilePolicy("public").name).toBe("public");
      const wrapped = gate.wrap("f", async () => 1, { origin: "public" });
      await expect(wrapped({})).resolves.toBe(1);
    });
  });

  it("heals an unresolved owner through the injected profile reader", async () => {
    await withTempDir(async (home) => {
      const { log } = memoryLogger();
      const account = testAccount();
      const address = normalizeAddress(account.address);
      const humanId = MockAgentBook.humanIdOf(address);
      let reads = 0;
      const read = async () => {
        reads += 1;
        return reads <= 2 ? undefined : { address, humanId };
      };
      let now = Date.parse("2026-09-08T02:15:30.123Z");
      const gate = await buildGate(
        validateConfig({ origins: ["https://work.example.com/mcp"] }, { nodeEnv: undefined }),
        {
          env: { HORS_HOME: home },
          log,
          agentBook: new MockAgentBook(),
          readProfile: read,
          now: () => now,
        },
      );
      expect(gate.owner()).toBeNull();
      expect(gate.mock).toBe(false);
      const first = await gate.evaluate({
        fn: "f",
        argsHash: DEFAULT_ARGS_HASH,
        envelope: (await signedEnvelope(account, { fn: "f", now })).raw,
        transport: "http",
        local: false,
        url: WORK_URL,
      });
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.denial.code).toBe("HORS_OWNER_UNRESOLVED");
      }
      now += 10_001;
      const second = await gate.evaluate({
        fn: "f",
        argsHash: DEFAULT_ARGS_HASH,
        envelope: (await signedEnvelope(account, { fn: "f", now })).raw,
        transport: "http",
        local: false,
        url: WORK_URL,
      });
      expect(second.ok).toBe(true);
      expect(gate.owner()).toBe(humanId);
      expect(reads).toBe(3);
    });
  });

  it("leaves hashing to the pipeline and exposes mock and log", async () => {
    await withTempDir(async (home) => {
      const { log, events } = memoryLogger();
      const gate = await buildGate(
        validateConfig({ dev: { mockOrigin: true } }, { nodeEnv: undefined }),
        { env: { HORS_HOME: home }, log },
      );
      expect(gate.mock).toBe(true);
      gate.log("info", "x");
      expect(events).toContainEqual(expect.objectContaining({ level: "info", message: "x" }));

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const audits: string[] = [];
      gate.on("audit", (event) => {
        audits.push(event.status);
      });
      await expect(gate.wrap("f", async () => "ok", "public")(cyclic)).rejects.toSatisfy(
        (error) => {
          expect(error).toBeInstanceOf(HorsError);
          expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
          return true;
        },
      );
      expect(audits).toEqual(["deny"]);

      const off = await buildGate(validateConfig({}, { nodeEnv: undefined }), {
        env: { HORS_HOME: home },
        log,
        agentBook: new MockAgentBook(),
      });
      expect(off.mock).toBe(false);
    });
  });
});
