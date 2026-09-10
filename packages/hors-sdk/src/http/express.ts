import type { IncomingMessage, ServerResponse } from "node:http";
import { httpFunctionId } from "../binding.js";
import { HorsError } from "../errors.js";
import type { Gate } from "../gate/gate.js";
import { concat } from "../limit.js";
import { isWebResponse } from "../plain.js";
import type { CompiledPolicy } from "../policy/types.js";
import { BodyLimitError, readNodeBody } from "./body.js";
import { encodeHeaderJson } from "./envelope-header.js";
import { runHttpCall } from "./pipeline.js";
import { bodyTooLarge, denialResponse, policyError } from "./response.js";
import type { ExpressRequest, WellKnownDocument } from "./types.js";

interface ExpressInternals {
  readonly gate: Gate;
  readonly compiled: CompiledPolicy | undefined;
  readonly maxBodyBytes: number;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function expressPath(req: ExpressRequest): string {
  const raw = typeof req.originalUrl === "string" ? req.originalUrl : (req.url ?? "/");
  return raw.split(/[?#]/)[0] ?? "/";
}

function expressLocation(req: ExpressRequest): {
  host: string | undefined;
  forwardedHost: string | undefined;
  path: string;
} {
  return {
    host: headerValue(req.headers.host),
    forwardedHost: headerValue(req.headers["x-forwarded-host"]),
    path: expressPath(req),
  };
}

function nodeHeader(req: IncomingMessage, name: string): string | undefined {
  return headerValue(req.headers[name.toLowerCase()]);
}

function toBytes(chunk: unknown, encoding?: unknown): Uint8Array {
  if (chunk === undefined || chunk === null || typeof chunk === "function") {
    return new Uint8Array();
  }
  if (typeof chunk === "string") {
    return new Uint8Array(
      Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8"),
    );
  }
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  return new TextEncoder().encode(String(chunk));
}

async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(new Uint8Array(await response.arrayBuffer()));
}

function attachHors(req: ExpressRequest, ctx: object): void {
  Object.defineProperty(req, "hors", {
    value: ctx,
    enumerable: true,
    configurable: true,
    writable: false,
  });
}

function streamConsumed(req: ExpressRequest): boolean {
  return req.body !== undefined || req.readableEnded === true || req.readableDidRead === true;
}

async function expressBytes(
  req: ExpressRequest,
  maxBodyBytes: number,
  gate: Gate,
  policy: { readonly name?: string },
): Promise<Uint8Array | Response> {
  if (req.rawBody instanceof Uint8Array) {
    if (req.rawBody.byteLength > maxBodyBytes) {
      gate.log("info", "hors http: request body exceeds maxBodyBytes", { max: maxBodyBytes });
      return bodyTooLarge(maxBodyBytes);
    }
    return req.rawBody;
  }
  // Read the stream only when it has not been consumed. Do not also
  // require `complete !== true` — Node marks small requests complete before
  // the stream is read, which would fail-closed on ordinary POSTs.
  if (!streamConsumed(req)) {
    try {
      const bytes = await readNodeBody(req, maxBodyBytes);
      req.rawBody = bytes;
      return bytes;
    } catch (error) {
      if (error instanceof BodyLimitError) {
        gate.log("info", "hors http: request body exceeds maxBodyBytes", { max: error.maxBytes });
        return bodyTooLarge(error.maxBytes);
      }
      throw error;
    }
  }
  gate.log(
    "error",
    "hors http: request body was consumed before the guard ran; mount guard.express() before body parsers or keep req.rawBody",
  );
  return denialResponse(policyError(gate, policy));
}

export async function runExpress(
  req: ExpressRequest,
  res: ServerResponse,
  next: (error?: unknown) => void,
  internals: ExpressInternals,
): Promise<void> {
  const { gate, compiled, maxBodyBytes } = internals;
  const method = (req.method ?? "GET").toUpperCase();
  const path = expressPath(req);
  const name = httpFunctionId(method, path);
  const policy = compiled ?? gate.policyFor(name);
  const bytes = await expressBytes(req, maxBodyBytes, gate, policy);
  if (isWebResponse(bytes)) {
    await writeNodeResponse(res, bytes);
    return;
  }
  const useMiddleware = policy.use.length > 0;
  try {
    const outcome = await runHttpCall(gate, compiled, {
      fn: name,
      bytes,
      contentType: nodeHeader(req, "content-type") ?? null,
      authorization: nodeHeader(req, "hors-authorization"),
      meta: nodeHeader(req, "hors-meta"),
      url: expressLocation(req),
      request: req,
      handler: useMiddleware
        ? (ctx) => {
            attachHors(req, ctx);
            return bufferDownstream(req, res, next);
          }
        : undefined,
    });
    if (isWebResponse(outcome)) {
      await writeNodeResponse(res, outcome);
      return;
    }
    attachHors(req, outcome.decision.ctx);
    res.setHeader("HORS-Result", encodeHeaderJson(outcome.decision.result));
    next();
  } catch (error) {
    if (res.destroyed || res.writableEnded) {
      return;
    }
    next(error);
  }
}

function bufferDownstream(
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
): Promise<Response> {
  const chunks: Uint8Array[] = [];
  let status = res.statusCode;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origWriteHead = res.writeHead.bind(res);
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = req.socket ?? res.socket;
    const onError = (error: Error) => {
      settle({ ok: false, error });
    };
    const onClose = () => {
      settle({
        ok: false,
        error: new HorsError("HORS_POLICY_ERROR", "response closed before the handler finished"),
      });
    };
    const settle = (
      outcome: { ok: true; body: Uint8Array } | { ok: false; error: unknown },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      res.write = origWrite;
      res.end = origEnd;
      res.writeHead = origWriteHead;
      socket?.removeListener("close", onClose);
      socket?.removeListener("error", onError);
      res.removeListener("error", onError);
      res.removeListener("close", onClose);
      if (!outcome.ok) {
        reject(outcome.error);
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.getHeaders())) {
        if (value === undefined) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
      resolve(
        new Response(outcome.body.byteLength === 0 ? null : outcome.body, { status, headers }),
      );
    };
    socket?.once("close", onClose);
    socket?.once("error", onError);
    res.on("error", onError);
    res.on("close", onClose);
    // Node's writeHead/write/end have 2–4 arity overloads; one wrapper each.
    res.writeHead = ((code: number, ...rest: unknown[]) => {
      status = code;
      res.statusCode = code;
      const headers = rest.find((value) => value !== undefined && typeof value === "object");
      if (headers !== undefined && !Array.isArray(headers)) {
        for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
          if (typeof value === "string" || typeof value === "number" || Array.isArray(value)) {
            res.setHeader(name, value);
          }
        }
      }
      return res;
    }) as typeof res.writeHead;
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      chunks.push(toBytes(chunk, encoding));
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") {
        done();
      }
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (chunk !== undefined && typeof chunk !== "function") {
        chunks.push(toBytes(chunk, encoding));
      }
      status = res.statusCode || status;
      let size = 0;
      for (const part of chunks) {
        size += part.byteLength;
      }
      settle({ ok: true, body: concat(chunks, size) });
      const done = [chunk, encoding, cb].find((value) => typeof value === "function");
      if (typeof done === "function") {
        done();
      }
      return res;
    }) as typeof res.end;
    next();
  });
}

export function wellKnownHandler(
  published: () => WellKnownDocument,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(published()));
  };
}
