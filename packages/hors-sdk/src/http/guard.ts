import type { ServerResponse } from "node:http";
import { httpFunctionId } from "../binding.js";
import { HorsError } from "../errors.js";
import { createGate, type Gate } from "../gate/gate.js";
import { isWebResponse } from "../plain.js";
import { publishPolicy } from "../policy/compile.js";
import { compilePolicy } from "../policy/registry.js";
import type { CompiledPolicy, Policy } from "../policy/types.js";
import { locationOf } from "../verify/expected-url.js";
import { BodyLimitError, readWebBody } from "./body.js";
import { runExpress, wellKnownHandler } from "./express.js";
import { runHttpCall } from "./pipeline.js";
import { bodyTooLarge, stampResponse } from "./response.js";
import type {
  ExpressRequest,
  HorsHttpOptions,
  HttpGuard,
  HttpHandler,
  WellKnownDocument,
} from "./types.js";

const declared = new WeakMap<Gate, Map<string, CompiledPolicy>>();
const FN_SHAPE = /^[A-Z]+ \//;
const DEFAULT_MAX_BODY = 1_048_576;

function normalisedDeclaredFn(fn: string): string {
  if (!FN_SHAPE.test(fn)) {
    throw new HorsError("CONFIG_INVALID", "fn must be a normalised HTTP function id");
  }
  const space = fn.indexOf(" ");
  const method = fn.slice(0, space);
  const path = fn.slice(space + 1);
  let normalised: string;
  try {
    normalised = httpFunctionId(method ?? "", path ?? "");
  } catch (error) {
    throw new HorsError("CONFIG_INVALID", "fn must be a normalised HTTP function id", undefined, {
      cause: error,
    });
  }
  if (normalised !== fn) {
    throw new HorsError("CONFIG_INVALID", "fn must be a normalised HTTP function id");
  }
  return fn;
}

function maxBodyBytesOf(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_BODY;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HorsError("CONFIG_INVALID", "maxBodyBytes must be a positive safe integer");
  }
  return value;
}

function registerDeclared(gate: Gate, fn: string, policy: CompiledPolicy): void {
  let map = declared.get(gate);
  if (map === undefined) {
    map = new Map();
    declared.set(gate, map);
  }
  if (map.has(fn)) {
    throw new HorsError("CONFIG_INVALID", `fn ${fn} is already declared on this gate`);
  }
  map.set(fn, policy);
}

function publishedOf(gate: Gate): WellKnownDocument {
  const map = declared.get(gate) ?? new Map();
  const functions = [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fn, policy]) => ({ fn, policy: publishPolicy(policy) }));
  return { v: 1, functions };
}

export async function hors(policy?: Policy, options: HorsHttpOptions = {}): Promise<HttpGuard> {
  const { gate: provided, fn, maxBodyBytes: maxBodyOption, ...rest } = options;
  if (provided !== undefined && Object.keys(rest).length > 0) {
    throw new HorsError("CONFIG_INVALID", "options.gate excludes config options");
  }
  const maxBodyBytes = maxBodyBytesOf(maxBodyOption);
  const compiled = policy === undefined ? undefined : compilePolicy(policy);
  const gate = provided ?? (await createGate(rest));
  if (fn !== undefined) {
    registerDeclared(gate, normalisedDeclaredFn(fn), compiled ?? gate.policyFor(fn));
  }

  const published = (): WellKnownDocument => publishedOf(gate);

  const handle = async (request: Request, handler: HttpHandler): Promise<Response> => {
    const method = request.method.toUpperCase();
    const path = new URL(request.url).pathname;
    const name = httpFunctionId(method, path);
    let bytes: Uint8Array;
    try {
      bytes = await readWebBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyLimitError) {
        gate.log("info", "hors http: request body exceeds maxBodyBytes", { max: error.maxBytes });
        return bodyTooLarge(error.maxBytes);
      }
      throw error;
    }
    const replay =
      method === "GET" || method === "HEAD"
        ? new Request(request)
        : new Request(request, { body: bytes.byteLength === 0 ? null : bytes });
    const outcome = await runHttpCall(gate, compiled, {
      fn: name,
      bytes,
      contentType: request.headers.get("content-type"),
      authorization: request.headers.get("HORS-Authorization"),
      meta: request.headers.get("HORS-Meta"),
      url: locationOf(request),
      request,
      handler: (ctx) => handler(replay, ctx),
    });
    return isWebResponse(outcome)
      ? outcome
      : stampResponse(outcome.decision.value as Response, outcome.decision.result);
  };

  const express = () => {
    return (req: ExpressRequest, res: ServerResponse, next: (error?: unknown) => void) => {
      void runExpress(req, res, next, { gate, compiled, maxBodyBytes }).catch((error) =>
        next(error),
      );
    };
  };

  return {
    gate,
    handle,
    express,
    wellKnown: () => wellKnownHandler(published),
    published,
  };
}
