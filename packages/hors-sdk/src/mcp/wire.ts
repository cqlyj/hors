import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/server";
import type { Denial, HorsResultMeta } from "../gate/result.js";
import { isPlainObject } from "../plain.js";

export interface ToolsCallRequest {
  readonly id: RequestId;
  readonly name: string;
  readonly args: unknown; // params.arguments as received; undefined when absent
}

function requestId(value: unknown): RequestId | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function toolsCallOf(message: JSONRPCMessage): ToolsCallRequest | undefined {
  const body: unknown = message;
  if (!isPlainObject(body) || body.method !== "tools/call") {
    return undefined;
  }
  const id = requestId(body.id);
  const params = body.params;
  if (id === undefined || !isPlainObject(params) || typeof params.name !== "string") {
    return undefined;
  }
  if (params._meta !== undefined && !isPlainObject(params._meta)) {
    return undefined;
  }
  return { id, name: params.name, args: params.arguments };
}

export function responseIdOf(message: JSONRPCMessage): RequestId | undefined {
  const body: unknown = message;
  if (!isPlainObject(body) || "method" in body) {
    return undefined;
  }
  if (!("result" in body) && !("error" in body)) {
    return undefined;
  }
  return requestId(body.id);
}

export function denialResult(denial: Denial): {
  isError: true;
  content: [{ type: "text"; text: string }];
  _meta: { "hors/result": Denial["result"] };
} {
  return {
    isError: true,
    content: [{ type: "text", text: denial.text }],
    _meta: { "hors/result": denial.result },
  };
}

export function denialResponse(id: RequestId, denial: Denial): JSONRPCMessage {
  return { jsonrpc: "2.0", id, result: denialResult(denial) };
}

export function stampResult(value: unknown, result: HorsResultMeta): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const meta = isPlainObject(value._meta) ? value._meta : {};
  return { ...value, _meta: { ...meta, "hors/result": result } };
}
