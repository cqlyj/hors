import type { Env } from "../config/env.js";
import { resolveConfig } from "../config/load.js";
import { profileHome, readProfile } from "../config/profile.js";
import { type GateConfig, type HorsConfig, validateConfig } from "../config/schema.js";
import { HorsError } from "../errors.js";
import type { Address, HumanId } from "../identity.js";
import { isPlainObject } from "../plain.js";
import { publishPolicy } from "../policy/compile.js";
import { compilePolicy } from "../policy/registry.js";
import type { CompiledPolicy, HorsContext, Policy, PublishedPolicy } from "../policy/types.js";
import { MemoryStore } from "../store.js";
import { createSignatureVerifiers } from "../verify/signature.js";
import { type AgentBook, createAgentBook } from "../world/agentbook.js";
import { MockAgentBook } from "../world/mock.js";
import { type AuditEvent, type AuditListener, createAuditEmitter } from "./audit.js";
import { createLogger, type Logger } from "./logger.js";
import {
  createOwnerResolver,
  gateAddress,
  type OwnerResolver,
  warnOwnerUnresolved,
} from "./owner.js";
import { type Decision, type EvaluateInput, evaluate as runEvaluate } from "./pipeline.js";

export type Handler<T> = (args: unknown, ctx: HorsContext) => T | Promise<T>;
export type Wrapped<T> = (args: unknown, envelope?: unknown, meta?: unknown) => Promise<T>;

export interface Gate {
  owner(): HumanId | null;
  readonly address: Address | null;
  readonly mock: boolean;
  readonly log: Logger;
  policyFor(fn: string): CompiledPolicy;
  evaluate(input: EvaluateInput): Promise<Decision>;
  wrap<T>(fn: string, handler: Handler<T>, policy?: Policy): Wrapped<T>;
  publish(fn: string): PublishedPolicy;
  reload(partial: Pick<HorsConfig, "deny" | "functions">): void;
  on(event: "audit", listener: AuditListener): () => void;
}

export type CreateGateOptions = HorsConfig & { readonly configFile?: string | false };

export interface GateRuntime {
  readonly env: Env; // HORS_HOME, HORS_PRIVATE_KEY, NODE_ENV
  readonly log: Logger;
  readonly agentBook?: AgentBook; // test seam; default chosen from config.mock
  readonly readProfile?: typeof readProfile; // test seam
  readonly now?: () => number; // test seam
}

const RELOAD_KEYS = new Set(["deny", "functions"]);

export async function buildGate(config: GateConfig, runtime: GateRuntime): Promise<Gate> {
  const home = profileHome(runtime.env);
  const read = runtime.readProfile ?? readProfile;
  const profile = await read(home, config.profile);
  const { log } = runtime;
  const address = gateAddress({
    privateKey: runtime.env.HORS_PRIVATE_KEY,
    profile,
    mock: config.mock,
    log,
  });
  const owner: OwnerResolver = createOwnerResolver(
    {
      configured: config.owner,
      mock: config.mock,
      address,
      profile: { home, name: config.profile },
      initial: profile,
    },
    { readProfile: read, log },
  );
  const store = config.store ?? new MemoryStore();
  const agentBook =
    runtime.agentBook ??
    (config.mock
      ? new MockAgentBook()
      : createAgentBook({ rpcUrl: config.rpc.worldchain, store, cache: config.cache }));
  const signatureVerifier = createSignatureVerifiers(config.rpc.signatures, {
    worldchainRpcUrl: config.rpc.worldchain,
  });
  if (config.mock) {
    log(
      "error",
      "HORS mock mode: AgentBook is replaced by a deterministic mock; every wallet is its own fake human; refuse this in production",
      { address },
    );
  }
  log("info", "HORS gate ready", {
    profile: config.profile,
    address,
    owner: owner.current() ?? "unresolved",
    policy: config.policy.name ?? "inline",
    configuredFunctions: [...config.functions.keys()],
    mock: config.mock,
  });

  let settings = config;
  let warnedOnDenial = false;
  const emitter = createAuditEmitter(log);
  const deps = {
    settings: () => settings,
    store,
    agentBook,
    signatureVerifier,
    owner,
    address,
    log,
    audit: (event: AuditEvent) => {
      if (event.code === "HORS_OWNER_UNRESOLVED" && !warnedOnDenial) {
        warnedOnDenial = true;
        warnOwnerUnresolved(log, { home, name: config.profile });
      }
      emitter.emit(event);
    },
    now: runtime.now ?? Date.now,
    uuid: () => crypto.randomUUID(),
  };

  const gate: Gate = {
    owner: () => owner.current(),
    address,
    mock: config.mock,
    log,
    policyFor(fn) {
      return settings.functions.get(fn) ?? settings.policy;
    },
    evaluate(input) {
      return runEvaluate(input, deps);
    },
    wrap<T>(fn: string, handler: Handler<T>, policy?: Policy): Wrapped<T> {
      if (typeof fn !== "string" || fn === "") {
        throw new HorsError("CONFIG_INVALID", "wrap: fn must be a non-empty string");
      }
      if (typeof handler !== "function") {
        throw new HorsError("CONFIG_INVALID", "wrap: handler must be a function");
      }
      const compiled = policy === undefined ? undefined : compilePolicy(policy);
      return async (args, envelope?, meta?) => {
        const decision = await runEvaluate(
          {
            fn,
            args,
            envelope,
            meta,
            transport: "wrap",
            local: false,
            policy: compiled,
            handler: (ctx) => handler(args, ctx),
          },
          deps,
        );
        if (!decision.ok) {
          const { denial } = decision;
          throw new HorsError(
            denial.code,
            denial.reason,
            denial.challenge === null ? undefined : { challenge: denial.challenge },
          );
        }
        // HorsResult is unknown at the policy layer; T is the handler's return type.
        return decision.value as T;
      };
    },
    publish(fn) {
      return publishPolicy(gate.policyFor(fn));
    },
    reload(partial) {
      if (!isPlainObject(partial) || Object.keys(partial).some((key) => !RELOAD_KEYS.has(key))) {
        throw new HorsError("CONFIG_INVALID", "reload accepts only deny and functions");
      }
      const next = validateConfig(partial, { nodeEnv: runtime.env.NODE_ENV });
      settings = {
        ...settings,
        ...(Object.hasOwn(partial, "deny") ? { deny: next.deny } : {}),
        ...(Object.hasOwn(partial, "functions") ? { functions: next.functions } : {}),
      };
      log("info", "HORS config reloaded", {
        deny: settings.deny.size,
        configuredFunctions: [...settings.functions.keys()],
      });
    },
    on(event, listener) {
      if (event !== "audit") {
        throw new HorsError("CONFIG_INVALID", "unknown event");
      }
      return emitter.on(listener);
    },
  };
  return Object.freeze(gate);
}

export async function createGate(options: CreateGateOptions = {}): Promise<Gate> {
  const { configFile, ...rest } = options;
  const env: Env = { ...process.env };
  const resolved = await resolveConfig({
    options: rest,
    env,
    cwd: process.cwd(),
    configFile,
  });
  const log = createLogger(resolved.logLevel, (line) => {
    process.stderr.write(`${line}\n`);
  });
  return buildGate(resolved.config, { env, log });
}
