import type { IncomingMessage, ServerResponse } from "node:http";
import type { CreateGateOptions, Gate } from "../gate/gate.js";
import type { HorsContext, PublishedPolicy } from "../policy/types.js";

export interface HorsHttpOptions extends CreateGateOptions {
  readonly gate?: Gate; // prebuilt; excludes every configuration key (CONFIG_INVALID); fn and maxBodyBytes stay
  readonly fn?: string; // declared HTTP function id for the well-known listing, e.g. "POST /approve"
  readonly maxBodyBytes?: number; // default 1_048_576; larger bodies are answered 413 before HORS runs
}

export type HttpHandler = (request: Request, ctx: HorsContext) => Response | Promise<Response>;

export interface WellKnownDocument {
  v: 1;
  functions: { fn: string; policy: PublishedPolicy }[];
}

export interface HttpGuard {
  readonly gate: Gate;
  handle(request: Request, handler: HttpHandler): Promise<Response>;
  /** Streaming responses (SSE) are not supported on routes whose policy has middleware. */
  express(): (req: ExpressRequest, res: ServerResponse, next: (error?: unknown) => void) => void;
  wellKnown(): (req: IncomingMessage, res: ServerResponse) => void;
  published(): WellKnownDocument;
}

/** Express request fields the guard reads or writes. */
export interface ExpressRequest extends IncomingMessage {
  originalUrl?: string;
  rawBody?: unknown;
  body?: unknown;
  hors?: HorsContext;
}
