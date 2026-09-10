import { HorsError } from "../errors.js";

export type Env = Readonly<Record<string, string | undefined>>;

const LOG_LEVEL_NAMES = ["silent", "error", "info", "debug"] as const;
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

export function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function isLogLevelName(value: string): value is LogLevelName {
  return (LOG_LEVEL_NAMES as readonly string[]).includes(value);
}

export function envLayer(env: Env): Record<string, unknown> {
  const layer: Record<string, unknown> = {};
  const owner = nonEmpty(env.HORS_OWNER);
  if (owner !== undefined) {
    layer.owner = owner;
  }
  const profile = nonEmpty(env.HORS_PROFILE);
  if (profile !== undefined) {
    layer.profile = profile;
  }
  const worldchain = nonEmpty(env.HORS_WORLDCHAIN_RPC);
  if (worldchain !== undefined) {
    layer.rpc = { worldchain };
  }
  if (env.HORS_MOCK === "1") {
    layer.dev = { mockOrigin: true };
  }
  return layer;
}

export function logLevelFrom(env: Env): LogLevelName {
  const value = env.HORS_LOG;
  if (value === undefined || value === "") {
    return "info";
  }
  if (isLogLevelName(value)) {
    return value;
  }
  throw new HorsError("CONFIG_INVALID", "HORS_LOG must be one of silent, error, info, debug");
}
