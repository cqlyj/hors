import type { JSONRPCMessage, MessageExtraInfo, Transport } from "@modelcontextprotocol/server";

export interface RecordedCall {
  readonly args: unknown; // raw params.arguments
  readonly request: Request | undefined; // extra.request when it is a Web Request
  readonly network: boolean; // extra.request was present, regardless of type
}

export interface ProxyHooks {
  /** Return "swallow" to answer the message yourself (via `real.send`) and stop it reaching the SDK. */
  inbound(
    message: JSONRPCMessage,
    extra: MessageExtraInfo | undefined,
    real: Transport,
  ): "forward" | "swallow";
  /** Return a message to send it instead; `undefined` forwards `message`. */
  outbound(
    message: JSONRPCMessage,
  ): JSONRPCMessage | undefined | Promise<JSONRPCMessage | undefined>;
  closed(): void;
}

export function proxyTransport(real: Transport, hooks: ProxyHooks): Transport {
  const proxy: Transport = {
    get sessionId() {
      return real.sessionId;
    },
    get hasPerRequestStream() {
      return real.hasPerRequestStream;
    },
    start: () => real.start(),
    close: () => real.close(),
    send: async (message, options) => {
      const next = await hooks.outbound(message);
      return real.send(next === undefined ? message : next, options);
    },
  };
  real.onmessage = (message, extra) => {
    if (hooks.inbound(message, extra, real) === "swallow") {
      return;
    }
    proxy.onmessage?.(message, extra);
  };
  real.onclose = () => {
    hooks.closed();
    proxy.onclose?.();
  };
  real.onerror = (error) => {
    proxy.onerror?.(error);
  };
  if (typeof real.setProtocolVersion === "function") {
    proxy.setProtocolVersion = (version) => {
      real.setProtocolVersion?.(version);
    };
  }
  if (typeof real.setSupportedProtocolVersions === "function") {
    proxy.setSupportedProtocolVersions = (versions) => {
      real.setSupportedProtocolVersions?.(versions);
    };
  }
  return proxy;
}
