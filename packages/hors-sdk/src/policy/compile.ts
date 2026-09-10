import { echo, HorsError } from "../errors.js";
import { parseHumanId } from "../identity.js";
import { hasControlCharacter, isPlainObject } from "../plain.js";
import type {
  CompiledPolicy,
  HorsContext,
  Middleware,
  Origin,
  OriginFn,
  PolicyViewOrigin,
  PublishedOrigin,
  PublishedPolicy,
  Rule,
} from "./types.js";

const POLICY_KEYS = new Set(["origin", "rule", "use", "describe"]);
const ORIGIN_MEMBER =
  "origin member must be same-human, any-human, public, a humanId or a function";

function compileOriginMember(member: unknown): Origin {
  if (typeof member === "function") {
    return member as OriginFn;
  }
  if (member === "same-human" || member === "any-human" || member === "public") {
    return member;
  }
  if (typeof member === "string") {
    const parsed = parseHumanId(member);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  throw new HorsError("CONFIG_INVALID", ORIGIN_MEMBER);
}

function compileFns<T>(value: unknown, label: "rule" | "use"): T[] {
  if (value === undefined) {
    return [];
  }
  const list = Array.from(Array.isArray(value) ? value : [value]);
  if (!list.every((item) => typeof item === "function")) {
    throw new HorsError("CONFIG_INVALID", `${label} must be a function or an array of functions`);
  }
  return list as T[];
}

function assemble(
  origin: Origin[],
  rule: Rule[],
  use: Middleware[],
  describe?: string,
): CompiledPolicy {
  const custom =
    origin.some((member) => typeof member === "function") || rule.length > 0 || use.length > 0;
  return {
    origin,
    rule,
    use,
    ...(describe === undefined ? {} : { describe }),
    custom,
  };
}

export function compilePolicyObject(policy: unknown): CompiledPolicy {
  if (!isPlainObject(policy)) {
    throw new HorsError("CONFIG_INVALID", "policy must be a plain object");
  }
  // WHY: a silently ignored `rules:` would ship a policy with no rules.
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) {
      throw new HorsError("CONFIG_INVALID", `unknown policy key ${echo(key)}`);
    }
  }
  const originInput = policy.origin;
  const members = Array.from(
    originInput === undefined
      ? ["same-human"]
      : Array.isArray(originInput)
        ? originInput
        : [originInput],
  );
  if (members.length === 0) {
    throw new HorsError("CONFIG_INVALID", "origin must not be empty");
  }
  const describe = policy.describe;
  let described: string | undefined;
  if (describe !== undefined) {
    if (typeof describe !== "string") {
      throw new HorsError("CONFIG_INVALID", "describe must be a string");
    }
    if (describe.length > 512 || hasControlCharacter(describe)) {
      throw new HorsError(
        "CONFIG_INVALID",
        "describe must be at most 512 characters without control characters",
      );
    }
    described = describe;
  }
  return assemble(
    members.map(compileOriginMember),
    compileFns<Rule>(policy.rule, "rule"),
    compileFns<Middleware>(policy.use, "use"),
    described,
  );
}

function projectPublishedOrigin(origin: Origin): PublishedOrigin {
  if (typeof origin === "function") {
    return "custom";
  }
  if (origin === "same-human" || origin === "any-human" || origin === "public") {
    return origin;
  }
  return "human";
}

function projectViewOrigin(origin: Origin): PolicyViewOrigin {
  return typeof origin === "function" ? "custom" : origin;
}

export function publishPolicy(policy: CompiledPolicy): PublishedPolicy {
  return {
    v: 1,
    ...(policy.name === undefined ? {} : { name: policy.name }),
    origin: policy.origin.map(projectPublishedOrigin),
    custom: policy.custom,
    ...(policy.describe === undefined ? {} : { describe: policy.describe }),
  };
}

export function policyView(policy: CompiledPolicy): HorsContext["policy"] {
  const origin = policy.origin.map(projectViewOrigin);
  return policy.name === undefined ? { origin } : { name: policy.name, origin };
}
