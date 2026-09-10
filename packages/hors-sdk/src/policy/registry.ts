import { echo, HorsError } from "../errors.js";
import { compilePolicyObject } from "./compile.js";
import type { CompiledPolicy, Policy, PolicyObject } from "./types.js";

export const PRESET_NAMES = ["same-human", "any-human", "public"] as const;

const POLICY_NAME = /^[a-z][a-z0-9-]{0,63}$/;

function freezePolicy(policy: CompiledPolicy): CompiledPolicy {
  return Object.freeze({
    ...(policy.name === undefined ? {} : { name: policy.name }),
    origin: Object.freeze([...policy.origin]),
    rule: Object.freeze([...policy.rule]),
    use: Object.freeze([...policy.use]),
    ...(policy.describe === undefined ? {} : { describe: policy.describe }),
    custom: policy.custom,
  });
}

const presets = Object.fromEntries(
  PRESET_NAMES.map((name) => [
    name,
    freezePolicy({ name, origin: [name], rule: [], use: [], custom: false }),
  ]),
) as Readonly<Record<(typeof PRESET_NAMES)[number], CompiledPolicy>>;

const named = new Map<string, CompiledPolicy>();

function isPresetName(name: string): name is (typeof PRESET_NAMES)[number] {
  return (PRESET_NAMES as readonly string[]).includes(name);
}

export function lookupPolicy(name: string): CompiledPolicy | undefined {
  if (isPresetName(name)) {
    return presets[name];
  }
  return named.get(name);
}

export function definePolicy(name: string, policy: PolicyObject): void {
  if (typeof name !== "string") {
    throw new HorsError("CONFIG_INVALID", "policy name must be a string");
  }
  if (!POLICY_NAME.test(name) || isPresetName(name)) {
    throw new HorsError("CONFIG_INVALID", `policy name ${echo(name)} is invalid`);
  }
  if (named.has(name)) {
    throw new HorsError("CONFIG_INVALID", `policy ${name} is already defined`);
  }
  const compiled = compilePolicyObject(policy);
  named.set(name, freezePolicy({ name, ...compiled }));
}

export function compilePolicy(policy: Policy): CompiledPolicy;
export function compilePolicy(policy: unknown): CompiledPolicy;
export function compilePolicy(policy: unknown): CompiledPolicy {
  if (typeof policy === "string") {
    const found = lookupPolicy(policy);
    if (found === undefined) {
      throw new HorsError("CONFIG_INVALID", `unknown policy ${echo(policy)}`);
    }
    return {
      ...found,
      origin: [...found.origin],
      rule: [...found.rule],
      use: [...found.use],
    };
  }
  return compilePolicyObject(policy);
}
