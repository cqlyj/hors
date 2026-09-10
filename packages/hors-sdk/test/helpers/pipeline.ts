import { validateConfig } from "../../src/config/schema.js";
import type { AuditEvent } from "../../src/gate/audit.js";
import type { OwnerResolver } from "../../src/gate/owner.js";
import type { EvaluateInput, PipelineDeps } from "../../src/gate/pipeline.js";
import type { HumanId } from "../../src/identity.js";
import { MemoryStore } from "../../src/store.js";
import { MockAgentBook } from "../../src/world/mock.js";
import { ADDR_A, HUMAN_A } from "./context.js";
import { memoryLogger } from "./logger.js";
import { DEFAULT_ARGS_HASH, DEFAULT_FN } from "./sign.js";

export const WORK_URL = {
  host: "work.example.com",
  forwardedHost: undefined,
  path: "/mcp",
} as const;

export function fixedOwner(humanId: HumanId | null): OwnerResolver {
  return {
    current: () => humanId,
    resolve: async () => humanId,
  };
}

export function makeDeps(overrides?: Partial<PipelineDeps>): {
  deps: PipelineDeps;
  store: MemoryStore;
  agentBook: MockAgentBook;
  logs: ReturnType<typeof memoryLogger>["events"];
  events: AuditEvent[];
  clock: { now: number };
} {
  const store = new MemoryStore();
  const agentBook = new MockAgentBook();
  const { log, events: logs } = memoryLogger();
  const events: AuditEvent[] = [];
  const clock = {
    now: Date.parse("2026-09-08T02:15:30.123Z"),
  };
  let uuid = 0;
  const deps: PipelineDeps = {
    settings: () =>
      validateConfig(
        { dev: { mockOrigin: true }, origins: ["https://work.example.com/mcp"] },
        { nodeEnv: undefined },
      ),
    store,
    agentBook,
    signatureVerifier: () => undefined,
    owner: fixedOwner(HUMAN_A),
    address: ADDR_A,
    log,
    audit: (event) => {
      events.push(event);
    },
    now: () => clock.now,
    uuid: () => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    },
    ...overrides,
  };
  return { deps, store, agentBook, logs, events, clock };
}

export function evalInput(overrides?: Partial<EvaluateInput>): EvaluateInput {
  return {
    fn: DEFAULT_FN,
    argsHash: DEFAULT_ARGS_HASH,
    transport: "mcp-http",
    local: false,
    ...overrides,
  };
}
