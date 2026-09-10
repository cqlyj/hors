import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { proxyTransport, type RecordedCall } from "../src/mcp/proxy.js";
import { responseIdOf, toolsCallOf } from "../src/mcp/wire.js";

function fakeTransport(extras?: {
  sessionId?: string;
  hasPerRequestStream?: boolean;
  setProtocolVersion?: (version: string) => void;
  setSupportedProtocolVersions?: (versions: string[]) => void;
}): Transport & { sent: JSONRPCMessage[] } {
  const sent: JSONRPCMessage[] = [];
  const transport: Transport & { sent: JSONRPCMessage[] } = {
    sent,
    sessionId: extras?.sessionId,
    hasPerRequestStream: extras?.hasPerRequestStream,
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    send: vi.fn(async (message: JSONRPCMessage) => {
      sent.push(message);
    }),
  };
  if (extras?.setProtocolVersion) {
    transport.setProtocolVersion = extras.setProtocolVersion;
  }
  if (extras?.setSupportedProtocolVersions) {
    transport.setSupportedProtocolVersions = extras.setSupportedProtocolVersions;
  }
  return transport;
}

describe("proxyTransport (S2.1, S2.2)", () => {
  it("forwards events assigned after construction", () => {
    const real = fakeTransport({ sessionId: "s1" });
    const inbound = vi.fn((): "forward" | "swallow" => "forward");
    const outbound = vi.fn();
    const closed = vi.fn();
    const proxy = proxyTransport(real, { inbound, outbound, closed });
    const onmessage = vi.fn();
    const onclose = vi.fn();
    const onerror = vi.fn();
    proxy.onmessage = onmessage;
    proxy.onclose = onclose;
    proxy.onerror = onerror;
    const message = { jsonrpc: "2.0" as const, id: 1, method: "ping" };
    real.onmessage?.(message, { authInfo: undefined });
    expect(inbound).toHaveBeenCalledWith(message, { authInfo: undefined }, real);
    expect(onmessage).toHaveBeenCalledWith(message, { authInfo: undefined });
    real.sessionId = "s2";
    expect(proxy.sessionId).toBe("s2");
    inbound.mockReturnValueOnce("swallow");
    onmessage.mockClear();
    real.onmessage?.(message);
    expect(onmessage).not.toHaveBeenCalled();
    real.onclose?.();
    expect(closed).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
    real.onerror?.(new Error("x"));
    expect(onerror).toHaveBeenCalledOnce();
  });

  it("delegates optional protocol-version methods when the real transport has them", () => {
    const inbound = vi.fn((): "forward" | "swallow" => "forward");
    const real = fakeTransport({ sessionId: "s1" });
    const proxy = proxyTransport(real, { inbound, outbound: vi.fn(), closed: vi.fn() });
    expect(proxy.setProtocolVersion).toBeUndefined();
    const withVersion = fakeTransport({
      setProtocolVersion: vi.fn(),
      setSupportedProtocolVersions: vi.fn(),
      hasPerRequestStream: true,
    });
    const versioned = proxyTransport(withVersion, {
      inbound,
      outbound: vi.fn(),
      closed: vi.fn(),
    });
    expect(versioned.hasPerRequestStream).toBe(true);
    versioned.setProtocolVersion?.("2026-07-28");
    expect(withVersion.setProtocolVersion).toHaveBeenCalledWith("2026-07-28");
    versioned.setSupportedProtocolVersions?.(["2026-07-28"]);
    expect(withVersion.setSupportedProtocolVersions).toHaveBeenCalledWith(["2026-07-28"]);
    expect(proxy.setSupportedProtocolVersions).toBeUndefined();
  });

  it("forwards and rewrites outbound messages", async () => {
    const real = fakeTransport();
    const outbound = vi.fn();
    const proxy = proxyTransport(real, { inbound: () => "forward", outbound, closed: vi.fn() });
    const outgoing = { jsonrpc: "2.0" as const, id: 1, result: {} };
    await proxy.send(outgoing);
    expect(outbound).toHaveBeenCalledWith(outgoing);
    expect(real.sent).toEqual([outgoing]);
    const rewritten = fakeTransport();
    const rewrite = proxyTransport(rewritten, {
      inbound: () => "forward",
      outbound: async (message) => ({ ...message, id: 99 }),
      closed: vi.fn(),
    });
    await rewrite.send(outgoing);
    expect(rewritten.sent).toEqual([{ ...outgoing, id: 99 }]);
  });

  it("clears the pending table after a response and on close", () => {
    const pending = new Map<string | number, RecordedCall>();
    const registered = new Set(["a"]);
    const real = fakeTransport();
    const proxy = proxyTransport(real, {
      inbound(message, extra) {
        const call = toolsCallOf(message);
        if (call === undefined) {
          return "forward";
        }
        if (registered.has(call.name)) {
          pending.set(call.id, {
            args: call.args,
            request: extra?.request instanceof Request ? extra.request : undefined,
            network: extra?.request !== undefined,
          });
          return "forward";
        }
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
    });

    real.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "a", arguments: { n: 1 } },
    });
    expect(pending.get(1)?.args).toEqual({ n: 1 });
    void proxy.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(pending.size).toBe(0);

    real.onmessage?.({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "a" },
    });
    expect(pending.size).toBe(1);
    real.onclose?.();
    expect(pending.size).toBe(0);
  });
});
