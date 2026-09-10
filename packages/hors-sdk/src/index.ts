export { defineConfig, type HorsConfig } from "./config/schema.js";
export type { Envelope } from "./envelope.js";
export { type HorsCode, HorsError } from "./errors.js";
export type { AuditEvent, AuditListener } from "./gate/audit.js";
export type { CreateGateOptions, Gate, Handler, Wrapped } from "./gate/gate.js";
export { createGate } from "./gate/gate.js";
export type { Logger } from "./gate/logger.js";
export type { Decision, EvaluateInput } from "./gate/pipeline.js";
export type { Denial, HorsResultMeta } from "./gate/result.js";
export { hashArgs, hashBody } from "./hash.js";
export type { Address, ChainId, HumanId } from "./identity.js";
export { isPlainObject } from "./plain.js";
export { definePolicy } from "./policy/registry.js";
export type {
  CompiledPolicy,
  HorsContext,
  HorsResult,
  LogLevel,
  Middleware,
  Origin,
  OriginFn,
  Policy,
  PolicyObject,
  PublishedOrigin,
  PublishedPolicy,
  Rule,
  Verdict,
} from "./policy/types.js";
export { MemoryStore, type Store } from "./store.js";
