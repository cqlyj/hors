import { HorsError, isPlainObject } from "hors-sdk";
import { UsageError } from "./io.js";
import type { Outcome } from "./output.js";

export function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorText(error: unknown): string {
  const message = thrownMessage(error);
  if (error instanceof Error && error.cause !== undefined) {
    const first = thrownMessage(error.cause).split(/\r?\n/, 1)[0] ?? "";
    const clipped = first.length > 200 ? `${first.slice(0, 200)}…` : first;
    return `${message}: ${clipped}`;
  }
  return message;
}

export function connectCommand(profile: string, homeFlag?: string): string {
  const home = homeFlag === undefined || homeFlag === "" ? "" : ` --home ${homeFlag}`;
  return `npx -y hors-cli connect --profile ${profile}${home}`;
}

export function notConnected(name: string, homeFlag?: string): Outcome {
  return {
    type: "err",
    exit: 4,
    code: "PROFILE_NOT_FOUND",
    message: `not connected: run ${connectCommand(name, homeFlag)} in a visible terminal`,
  };
}

export function asOutcome(error: unknown): Outcome {
  if (error instanceof UsageError) {
    return { type: "err", exit: 2, code: "USAGE", message: error.message };
  }
  if (error instanceof HorsError) {
    if (error.code === "PROFILE_NOT_FOUND") {
      const match = /--profile (\S+)/.exec(error.message);
      return notConnected(match?.[1] ?? "default");
    }
    return {
      type: "err",
      exit: error.code === "CONFIG_INVALID" && error.message.includes("profile name") ? 2 : 1,
      code: error.code,
      message: errorText(error),
    };
  }
  return { type: "err", exit: 1, code: "HORS_UNAVAILABLE", message: errorText(error) };
}

export function parseObjectJson(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`${label} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new UsageError(`${label} must be a JSON object`);
  }
  return parsed;
}
