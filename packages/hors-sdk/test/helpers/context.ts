import { denial, isCustomCode } from "../../src/errors.js";
import type { Address } from "../../src/identity.js";
import { normalizeHumanId } from "../../src/identity.js";
import type { HorsContext, LogLevel } from "../../src/policy/types.js";
import { MemoryStore } from "../../src/store.js";

export const HUMAN_A = normalizeHumanId(0xan);
export const HUMAN_B = normalizeHumanId(0xbn);
export const ADDR_A: Address = "0x000000000000000000000000000000000000000a";

export interface TestContext {
  ctx: HorsContext;
  logs: Array<{ level: LogLevel; message: string; data?: Record<string, unknown> }>;
}

export function makeContext(overrides?: Partial<HorsContext>): TestContext {
  const logs: TestContext["logs"] = [];
  const ctx: HorsContext = {
    v: 1,
    fn: "approveTravelExpense",
    args: { amount: 850 },
    argsHash: "f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab",
    callId: "6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f",
    local: false,
    transport: "test",
    callerAddress: ADDR_A,
    callerHumanId: HUMAN_A,
    callerChainId: "eip155:480",
    ownerHumanId: HUMAN_A,
    policy: { name: "same-human", origin: ["same-human"] },
    meta: {},
    state: {},
    store: new MemoryStore(),
    now: Date.parse("2026-09-08T02:15:30.123Z"),
    request: undefined,
    deny: (reason, opts) => {
      if (
        typeof reason !== "string" ||
        reason === "" ||
        (opts?.code !== undefined && !isCustomCode(opts.code))
      ) {
        logs.push({
          level: "error",
          message: "invalid ctx.deny call",
          data: { reason: typeof reason, code: opts?.code },
        });
        throw denial("HORS_POLICY_ERROR", "policy evaluation failed");
      }
      throw denial(opts?.code ?? "HORS_RULE_DENIED", reason, opts?.challenge);
    },
    log: (level, message, data) => {
      logs.push({ level, message, data });
    },
    ...overrides,
  };
  return { ctx, logs };
}
