import { describe, expect, it } from "vitest";
import { detectCall } from "../src/mcp/detect.js";

describe("detectCall", () => {
  it("treats no signals as local", () => {
    expect(detectCall({ ctx: {} })).toEqual({ local: true, request: undefined });
  });

  it("treats extra.request alone as network", () => {
    const request = new Request("https://work.example.com/mcp");
    expect(detectCall({ ctx: {}, recorded: { network: true, request } })).toEqual({
      local: false,
      request,
    });
    expect(detectCall({ ctx: {}, recorded: { network: true } })).toEqual({
      local: false,
      request: undefined,
    });
  });

  it("treats ctx.http = {} as network with no URL", () => {
    expect(detectCall({ ctx: { http: {} } })).toEqual({ local: false, request: undefined });
  });

  it("uses ctx.http.req when it is a Request", () => {
    const request = new Request("https://work.example.com/mcp");
    expect(detectCall({ ctx: { http: { req: request } } })).toEqual({ local: false, request });
  });

  it("detects a Request created before the global class was replaced (hono node-server)", () => {
    const Builtin = globalThis.Request;
    class Patched extends Builtin {}
    Object.defineProperty(globalThis, "Request", { value: Patched, configurable: true });
    try {
      const req = new Builtin("http://svc.example/mcp", {
        method: "POST",
        headers: { host: "svc.example" },
      });
      expect(req instanceof Request).toBe(false); // the trap this test guards
      expect(detectCall({ ctx: { http: { req } } }).request).toBe(req);
    } finally {
      Object.defineProperty(globalThis, "Request", { value: Builtin, configurable: true });
    }
  });

  it("lets transport overrides win", () => {
    const request = new Request("https://work.example.com/mcp");
    expect(detectCall({ override: "stdio", ctx: { http: { req: request } } })).toEqual({
      local: true,
      request,
    });
    expect(detectCall({ override: "http", ctx: {} })).toEqual({ local: false, request: undefined });
  });
});
