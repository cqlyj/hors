import type {
  McpServer,
  MessageExtraInfo,
  RequestId,
  ServerContext,
  Transport,
} from "@modelcontextprotocol/server";
import { HorsError, NO_POLICY_REASON, thrownMessage } from "../errors.js";
import { createGate, type Gate } from "../gate/gate.js";
import { type Denial, denialFrom, policyError } from "../gate/result.js";
import { isPlainObject, isWebRequest } from "../plain.js";
import { publishPolicy } from "../policy/compile.js";
import { compilePolicy } from "../policy/registry.js";
import type { CompiledPolicy } from "../policy/types.js";
import { locationOf } from "../verify/expected-url.js";
import { detectCall } from "./detect.js";
import { proxyTransport, type RecordedCall } from "./proxy.js";
import type { HorsMcpOptions, HorsMcpServer, HorsRegisterTool } from "./types.js";
import { denialResponse, denialResult, responseIdOf, stampResult, toolsCallOf } from "./wire.js";

const wrappedServers = new WeakSet<object>();
const NO_POLICY = {};

interface ToolRecord {
  name: string;
  policy: CompiledPolicy | undefined;
  callback: (...args: unknown[]) => unknown;
}

function isServerContext(value: unknown): value is ServerContext {
  return (
    isPlainObject(value) &&
    isPlainObject(value.mcpReq) &&
    (typeof value.mcpReq.id === "string" || typeof value.mcpReq.id === "number")
  );
}

function recordedFrom(extra: MessageExtraInfo | undefined, args: unknown): RecordedCall {
  return {
    args,
    request: isWebRequest(extra?.request) ? extra.request : undefined,
    network: extra?.request !== undefined,
  };
}

function policyErrorDenial(gate: Gate, local: boolean): Denial {
  return policyError(gate, { policy: NO_POLICY, local });
}

function noPolicyDenial(gate: Gate, local: boolean): Denial {
  return denialFrom(new HorsError("HORS_POLICY_ERROR", NO_POLICY_REASON), {
    policy: NO_POLICY,
    local,
    mock: gate.mock,
    log: gate.log,
  });
}

export async function hors(
  server: McpServer | HorsMcpServer,
  options: HorsMcpOptions = {},
): Promise<HorsMcpServer> {
  const { gate: provided, transport: override, ...rest } = options;
  if (override !== undefined && override !== "stdio" && override !== "http") {
    throw new HorsError("CONFIG_INVALID", "options.transport must be stdio or http");
  }
  if (provided !== undefined && Object.keys(rest).length > 0) {
    throw new HorsError("CONFIG_INVALID", "options.gate excludes config options");
  }
  if (wrappedServers.has(server)) {
    throw new HorsError("CONFIG_INVALID", "hors() was already applied to this server");
  }
  const raw = server as McpServer;
  if (raw.isConnected()) {
    throw new HorsError("CONFIG_INVALID", "apply hors() before connect");
  }
  const gate = provided ?? (await createGate(rest));
  const registry = new Map<string, ToolRecord>();
  const pending = new Map<RequestId, RecordedCall>();
  const realRegisterTool = raw.registerTool.bind(raw);
  const realConnect = raw.connect.bind(raw);

  const refuse = (real: Transport, id: RequestId, fn: string, extra?: MessageExtraInfo): void => {
    const { local } = detectCall({
      override,
      ctx: {},
      recorded: recordedFrom(extra, undefined),
    });
    const denial = noPolicyDenial(gate, local);
    gate.log("error", "hors mcp: tool is not registered through hors(); refusing the call", { fn });
    real.send(denialResponse(id, denial)).catch((error) =>
      gate.log("error", "hors mcp: could not send the refusal", {
        fn,
        error: thrownMessage(error),
      }),
    );
  };

  const guard = async (record: ToolRecord, cbArgs: readonly unknown[]): Promise<unknown> => {
    const last = cbArgs[cbArgs.length - 1];
    if (!isServerContext(last)) {
      const { local } = detectCall({ override, ctx: last });
      return denialResult(policyErrorDenial(gate, local));
    }
    const ctx = last;
    const id = ctx.mcpReq.id;
    const recorded = pending.get(id);
    pending.delete(id);
    const { local, request: httpReq } = detectCall({ override, ctx, recorded });
    if (recorded === undefined) {
      gate.log(
        "error",
        "hors mcp: no recorded arguments for this request; connect the server through the instance returned by hors()",
      );
      return denialResult(policyErrorDenial(gate, local));
    }
    const mcpMeta = ctx.mcpReq._meta;
    const decision = await gate.evaluate({
      fn: record.name,
      args: recorded.args,
      envelope: mcpMeta?.["hors/auth"],
      meta: mcpMeta?.["hors/meta"],
      transport: local ? "mcp-stdio" : "mcp-http",
      local,
      request: ctx,
      url: httpReq === undefined ? undefined : locationOf(httpReq),
      policy: record.policy,
      handler: (horsCtx) => {
        Object.defineProperty(ctx, "hors", {
          value: horsCtx,
          enumerable: true,
          configurable: true,
          writable: false,
        });
        return record.callback(...cbArgs);
      },
    });
    return decision.ok
      ? stampResult(decision.value, decision.result)
      : denialResult(decision.denial);
  };

  const register: HorsRegisterTool = (name, config, cb) => {
    const { hors: inline, ...restConfig } = config;
    const policy = inline === undefined ? undefined : compilePolicy(inline);
    const stamped = {
      ...restConfig,
      _meta: { ...restConfig._meta, "hors/policy": publishPolicy(policy ?? gate.policyFor(name)) },
    };
    // MCP SDK boundary: ToolCallback arity union is not a single function type.
    const record: ToolRecord = { name, policy, callback: cb as ToolRecord["callback"] };
    const wrapped = (...cbArgs: unknown[]) => guard(record, cbArgs);
    // MCP SDK boundary: ToolCallback overloads cannot express the F2 (...cbArgs) wrapper.
    const registered = realRegisterTool(name, stamped as never, wrapped as never);
    registry.set(name, record);
    const realUpdate = registered.update.bind(registered);
    registered.update = (updates) => {
      if (
        updates.name !== undefined &&
        updates.name !== record.name &&
        updates.name &&
        registry.has(updates.name)
      ) {
        throw new HorsError("CONFIG_INVALID", "tool name is already registered");
      }
      const next = { ...updates };
      if (updates.callback !== undefined) {
        // MCP SDK boundary: ToolCallback arity union.
        next.callback = wrapped as never;
      }
      if (updates.name !== undefined && updates.name !== record.name && updates.name) {
        if (record.policy === undefined && updates._meta === undefined) {
          next._meta = {
            ...registered._meta,
            "hors/policy": publishPolicy(gate.policyFor(updates.name)),
          };
        }
      }
      if (updates._meta !== undefined) {
        const fn = updates.name !== undefined && updates.name ? updates.name : record.name;
        next._meta = {
          ...updates._meta,
          "hors/policy": publishPolicy(record.policy ?? gate.policyFor(fn)),
        };
      }
      const result = realUpdate(next);
      if (updates.callback !== undefined) {
        // MCP SDK boundary: ToolCallback arity union.
        record.callback = updates.callback as ToolRecord["callback"];
      }
      if (updates.name !== undefined && updates.name !== record.name) {
        registry.delete(record.name);
        // SDK's remove() is update({ name: null }).
        if (updates.name) {
          record.name = updates.name;
          registry.set(record.name, record);
        }
      }
      return result;
    };
    return registered;
  };
  // MCP SDK boundary: HorsRegisterTool adds the hors config key the SDK type does not declare.
  raw.registerTool = register as McpServer["registerTool"];

  // MCP SDK boundary: connect's parameter type is invariant over Transport.
  raw.connect = ((transport: Transport) =>
    realConnect(
      proxyTransport(transport, {
        inbound(message, extra, real) {
          const call = toolsCallOf(message);
          if (call === undefined) {
            return "forward";
          }
          if (pending.has(call.id)) {
            pending.delete(call.id);
            gate.log("error", "duplicate in-flight request id", { fn: call.name });
            refuse(real, call.id, call.name, extra);
            return "swallow";
          }
          if (registry.has(call.name)) {
            pending.set(call.id, recordedFrom(extra, call.args));
            return "forward";
          }
          refuse(real, call.id, call.name, extra);
          return "swallow";
        },
        outbound(message) {
          const id = responseIdOf(message);
          if (id !== undefined) {
            pending.delete(id);
          }
        },
        closed() {
          pending.clear();
        },
      }),
    )) as McpServer["connect"];

  wrappedServers.add(raw);
  return raw as unknown as HorsMcpServer; // widened return type
}
