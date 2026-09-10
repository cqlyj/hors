import {
  denial,
  HorsError,
  isCustomCode,
  isPolicyDenial,
  POLICY_FAILED_REASON,
  thrownMessage,
} from "../errors.js";
import { isHumanId } from "../identity.js";
import type {
  CompiledPolicy,
  HorsContext,
  HorsResult,
  LogLevel,
  Origin,
  OriginFn,
} from "./types.js";

function policyError(cause?: unknown): HorsError {
  return denial(
    "HORS_POLICY_ERROR",
    POLICY_FAILED_REASON,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

function safeLog(
  ctx: HorsContext,
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  try {
    ctx.log(level, message, data);
  } catch {
    // A throwing logger must not turn a timeout into an uncaughtException.
  }
}

async function withTimeout<T>(
  run: () => T | Promise<T>,
  timeoutMs: number,
  ctx: HorsContext,
): Promise<T> {
  const work = Promise.resolve().then(run);
  let timedOut = false;
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        // WHY: reject first so a throwing logger cannot leave the request unsettled.
        reject(policyError());
        safeLog(ctx, "error", "policy evaluation timed out", { message: "timeout" });
      }, timeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          if (!timedOut) {
            resolve(value);
          }
        },
        (error) => {
          clearTimeout(timer);
          if (!timedOut) {
            reject(error);
          }
        },
      );
    });
  } catch (error) {
    if (timedOut) {
      throw error;
    }
    if (isPolicyDenial(error)) {
      throw error;
    }
    safeLog(ctx, "error", POLICY_FAILED_REASON, { message: thrownMessage(error) });
    throw policyError(error);
  }
}

function isLiteralOrigin(member: Origin): member is Exclude<Origin, OriginFn> {
  return typeof member !== "function";
}

function matchesLiteral(origin: Exclude<Origin, OriginFn>, ctx: HorsContext): boolean {
  if (origin === "public") {
    return true;
  }
  if (origin === "same-human") {
    return (
      ctx.local === true || (isHumanId(ctx.callerHumanId) && ctx.callerHumanId === ctx.ownerHumanId)
    );
  }
  if (origin === "any-human") {
    return ctx.local === true || isHumanId(ctx.callerHumanId);
  }
  return ctx.callerHumanId !== null && ctx.callerHumanId === origin;
}

async function originFnMatches(
  fn: OriginFn,
  ctx: HorsContext,
  timeoutMs: number,
): Promise<boolean> {
  const result: unknown = await withTimeout(() => fn(ctx), timeoutMs, ctx);
  if (result === true) {
    return true;
  }
  if (result === false) {
    return false;
  }
  safeLog(ctx, "error", "invalid origin result", {
    type: result === null ? "null" : typeof result,
  });
  throw policyError();
}

export async function checkOrigin(
  policy: CompiledPolicy,
  ctx: HorsContext,
  timeoutMs: number,
): Promise<void> {
  const literals = policy.origin.filter(isLiteralOrigin);
  const fns = policy.origin.filter((member): member is OriginFn => typeof member === "function");
  for (const origin of literals) {
    if (matchesLiteral(origin, ctx)) {
      return;
    }
  }
  for (const fn of fns) {
    if (await originFnMatches(fn, ctx, timeoutMs)) {
      return;
    }
  }
  if (!ctx.local && ctx.ownerHumanId === null && policy.origin.includes("same-human")) {
    throw new HorsError("HORS_OWNER_UNRESOLVED", "service owner is not resolved");
  }
  throw new HorsError("HORS_ORIGIN_MISMATCH", "caller does not match the function's origin");
}

function denyFromVerdict(verdict: unknown, ctx: HorsContext): never {
  if (verdict === false) {
    throw denial("HORS_RULE_DENIED", "denied by policy");
  }
  if (verdict === null || typeof verdict !== "object") {
    safeLog(ctx, "error", "invalid rule verdict", {
      type: verdict === null ? "null" : typeof verdict,
    });
    throw policyError();
  }
  const { deny, code, challenge } = verdict as {
    deny?: unknown;
    code?: unknown;
    challenge?: unknown;
  };
  if (typeof deny !== "string" || deny === "") {
    safeLog(ctx, "error", "invalid rule verdict", { type: typeof verdict });
    throw policyError();
  }
  if (code !== undefined && !isCustomCode(code)) {
    safeLog(ctx, "error", "invalid rule verdict", { type: typeof verdict, code });
    throw policyError();
  }
  throw denial(typeof code === "string" ? code : "HORS_RULE_DENIED", deny, challenge);
}

export async function runRules(
  policy: CompiledPolicy,
  ctx: HorsContext,
  timeoutMs: number,
): Promise<void> {
  // WHY: ctx.args is not frozen or copied — enforcing "rules MUST NOT mutate
  // args" would cost a deep freeze on every call.
  for (const rule of policy.rule) {
    const verdict: unknown = await withTimeout(() => rule(ctx), timeoutMs, ctx);
    if (verdict === true) {
      continue;
    }
    denyFromVerdict(verdict, ctx);
  }
}

export async function runMiddleware(
  policy: CompiledPolicy,
  ctx: HorsContext,
  handler: () => Promise<HorsResult>,
): Promise<HorsResult> {
  let settled = false;
  let handlerError: { readonly error: unknown } | undefined;
  const invoke = (index: number): (() => Promise<HorsResult>) => {
    const mw = policy.use[index];
    if (mw === undefined) {
      return async () => {
        try {
          return await handler();
        } catch (error) {
          handlerError = { error };
          throw error;
        }
      };
    }
    const next = invoke(index + 1);
    let called = false;
    const once = (): Promise<HorsResult> => {
      if (settled || called) {
        safeLog(ctx, "error", "middleware called next() twice");
        return Promise.reject(policyError());
      }
      called = true;
      const result = next();
      result.catch(() => undefined);
      return result;
    };
    return () => mw(ctx, once);
  };

  try {
    return await invoke(0)();
  } catch (error) {
    if (handlerError !== undefined && error === handlerError.error) {
      throw error;
    }
    if (isPolicyDenial(error)) {
      throw error;
    }
    safeLog(ctx, "error", POLICY_FAILED_REASON, { message: thrownMessage(error) });
    throw policyError(error);
  } finally {
    settled = true;
  }
}
