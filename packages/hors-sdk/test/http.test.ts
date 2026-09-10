import { afterEach, describe, expect, it, vi } from "vitest";
import { createSigner } from "../src/client/index.js";
import { HorsError } from "../src/errors.js";
import { hashBody } from "../src/hash.js";
import { decodeHeaderJson } from "../src/http/envelope-header.js";
import { hors } from "../src/http/index.js";
import { MemoryStore } from "../src/store.js";
import { testGate } from "./helpers/mcp.js";
import { withTempHome } from "./helpers/tmp.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const JSON_BODY = '{"amount":850,"currency":"EUR"}';
const JSON_HASH = "f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab";
const ZERO_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function echoHandler(
  _request: Request,
  ctx: { callerHumanId: unknown; fn: string; argsHash: string; args: unknown },
) {
  return Response.json({
    callerHumanId: ctx.callerHumanId,
    fn: ctx.fn,
    argsHash: ctx.argsHash,
    args: ctx.args,
  });
}

describe("hors HTTP adapter", () => {
  it("round-trips a signed POST and GET through handle()", async () => {
    await withTempHome(async (home) => {
      const { gate, account } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("same-human", { gate });
      const signer = await createSigner({
        account,
        fetch: (input, init) => guard.handle(new Request(input, init), echoHandler),
      });
      const posted = await signer.fetch("https://work.example.com/approve?x=1", {
        method: "POST",
        body: JSON_BODY,
        headers: { "content-type": "application/json" },
      });
      expect(posted.status).toBe(200);
      expect(decodeHeaderJson(posted.headers.get("HORS-Result") ?? "")).toEqual({
        v: 1,
        status: "ok",
        policy: "same-human",
        local: false,
        mock: true,
      });
      expect(await posted.json()).toEqual({
        callerHumanId: gate.owner(),
        fn: "POST /approve",
        argsHash: JSON_HASH,
        args: { amount: 850, currency: "EUR" },
      });

      const got = await signer.fetch("https://work.example.com/approve");
      expect(await got.json()).toMatchObject({
        fn: "GET /approve",
        argsHash: ZERO_HASH,
      });
    });
  });

  it("returns 401 JSON for an unsigned POST", async () => {
    await withTempHome(async (home) => {
      const { gate } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("same-human", { gate });
      const response = await guard.handle(
        new Request("https://work.example.com/approve", {
          method: "POST",
          body: JSON_BODY,
          headers: { "content-type": "application/json" },
        }),
        echoHandler,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("HORS");
      expect(response.headers.get("HORS-Result")).toBeTruthy();
      expect(await response.json()).toMatchObject({
        v: 1,
        status: "deny",
        code: "HORS_UNSIGNED",
        challenge: null,
      });
    });
  });

  it("denies when the body changes after signing", async () => {
    await withTempHome(async (home) => {
      const { gate, account } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("same-human", { gate });
      const signer = await createSigner({ account });
      const argsHash = await hashBody(new TextEncoder().encode(JSON_BODY));
      const envelope = await signer.sign({
        url: "https://work.example.com/approve",
        fn: "POST /approve",
        argsHash,
      });
      const { encodeHeaderJson } = await import("../src/http/envelope-header.js");
      const response = await guard.handle(
        new Request("https://work.example.com/approve", {
          method: "POST",
          body: '{"amount":851,"currency":"EUR"}',
          headers: {
            "content-type": "application/json",
            "HORS-Authorization": encodeHeaderJson(envelope),
          },
        }),
        echoHandler,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "HORS_ARGS_MISMATCH" });
    });
  });

  it("leaves ctx.args undefined for a non-JSON body", async () => {
    await withTempHome(async (home) => {
      const { gate, account } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("public", { gate });
      const signer = await createSigner({
        account,
        fetch: (input, init) => guard.handle(new Request(input, init), echoHandler),
      });
      const response = await signer.fetch("https://work.example.com/approve", {
        method: "POST",
        body: "plain",
        headers: { "content-type": "text/plain" },
      });
      expect(response.status).toBe(200);
      // JSON.stringify omits undefined; a missing key is the observable form of ctx.args === undefined.
      expect(await response.json()).not.toHaveProperty("args");
    });
  });

  it("normalises a trailing-slash path into the function id", async () => {
    await withTempHome(async (home) => {
      const { gate, account } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("public", { gate });
      const signer = await createSigner({
        account,
        fetch: (input, init) => guard.handle(new Request(input, init), echoHandler),
      });
      const response = await signer.fetch("https://work.example.com/approve/", { method: "POST" });
      expect(await response.json()).toMatchObject({ fn: "POST /approve" });
    });
  });

  it("answers 413 without HORS-Result when the body exceeds maxBodyBytes", async () => {
    await withTempHome(async (home) => {
      const { gate, audits, logs } = await testGate(home, {
        origins: ["https://work.example.com"],
      });
      const guard = await hors("public", { gate, maxBodyBytes: 4 });
      const response = await guard.handle(
        new Request("https://work.example.com/approve", { method: "POST", body: "12345" }),
        echoHandler,
      );
      expect(response.status).toBe(413);
      expect(response.headers.get("HORS-Result")).toBeNull();
      expect(await response.json()).toEqual({ error: "request body exceeds 4 bytes" });
      expect(audits).toEqual([]);
      expect(
        logs.some((event) => String(event.message).includes("request body exceeds maxBodyBytes")),
      ).toBe(true);
    });
  });

  it("rejects an unbounded streamed body after the cap and cancels the reader", async () => {
    await withTempHome(async (home) => {
      const { gate } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("public", { gate, maxBodyBytes: 1_048_576 });
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = await guard.handle(
        new Request("https://work.example.com/approve", {
          method: "POST",
          body: stream,
          duplex: "half",
        } as RequestInit),
        echoHandler,
      );
      expect(response.status).toBe(413);
      expect(pulls).toBeLessThanOrEqual(17);
      expect(cancelled).toBe(true);
    });
  });

  it("accepts a Response created before the global class was replaced (hono node-server)", async () => {
    await withTempHome(async (home) => {
      const { gate } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("public", { gate });
      const Builtin = globalThis.Response;
      class Patched extends Builtin {}
      Object.defineProperty(globalThis, "Response", { value: Patched, configurable: true });
      try {
        const fromBuiltin = new Builtin("ok", { status: 200 });
        expect(fromBuiltin instanceof Response).toBe(false); // the trap this test guards
        const response = await guard.handle(
          new Request("https://work.example.com/approve", { method: "POST" }),
          () => fromBuiltin,
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("ok");
        expect(response.headers.get("HORS-Result")).toBeTruthy();
      } finally {
        Object.defineProperty(globalThis, "Response", { value: Builtin, configurable: true });
      }
    });
  });

  it("denies when the handler does not return a Response", async () => {
    await withTempHome(async (home) => {
      const { gate, logs } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("public", { gate });
      const response = await guard.handle(
        new Request("https://work.example.com/approve", { method: "POST" }),
        () => "nope" as never,
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "HORS_POLICY_ERROR" });
      expect(
        logs.some((event) => String(event.message).includes("did not return a Response")),
      ).toBe(true);
    });
  });

  it("propagates a handler throw and still audits ok", async () => {
    await withTempHome(async (home) => {
      const { gate, audits } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("public", { gate });
      const error = new Error("boom");
      await expect(
        guard.handle(new Request("https://work.example.com/approve", { method: "POST" }), () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(audits).toEqual([expect.objectContaining({ status: "ok" })]);
    });
  });

  it("audits an undecodable HORS-Authorization or HORS-Meta header", async () => {
    await withTempHome(async (home) => {
      const store = new MemoryStore();
      const { gate, audits } = await testGate(home, {
        origins: ["https://work.example.com"],
        store,
      });
      const guard = await hors("same-human", { gate });
      const auth = await guard.handle(
        new Request("https://work.example.com/approve", {
          method: "POST",
          headers: { "HORS-Authorization": "!!!" },
        }),
        echoHandler,
      );
      expect(auth.status).toBe(400);
      expect(auth.headers.get("HORS-Result")).toBeTruthy();
      expect(await auth.json()).toMatchObject({ code: "HORS_BAD_ENVELOPE" });
      expect(audits).toEqual([expect.objectContaining({ code: "HORS_BAD_ENVELOPE" })]);
      expect(store.size).toBe(0);

      audits.length = 0;
      const meta = await guard.handle(
        new Request("https://work.example.com/approve", {
          method: "POST",
          headers: { "HORS-Meta": "!!!" },
        }),
        echoHandler,
      );
      expect(meta.status).toBe(400);
      expect(meta.headers.get("HORS-Result")).toBeTruthy();
      expect(await meta.json()).toMatchObject({ code: "HORS_BAD_ENVELOPE" });
      expect(audits).toEqual([expect.objectContaining({ code: "HORS_BAD_ENVELOPE" })]);
      expect(store.size).toBe(0);
    });
  });

  it("lets middleware mutate the response", async () => {
    await withTempHome(async (home) => {
      const { gate, account } = await testGate(home, { origins: ["https://work.example.com"] });
      const seen = await hors(
        {
          origin: "public",
          use: async (_ctx, next) => {
            const response = await next();
            if (response instanceof Response) {
              response.headers.set("x-seen", "1");
            }
            return response;
          },
        },
        { gate },
      );
      const signer = await createSigner({
        account,
        fetch: (input, init) =>
          seen.handle(new Request(input, init), () => new Response("ok", { status: 200 })),
      });
      const ok = await signer.fetch("https://work.example.com/approve", { method: "POST" });
      expect(ok.headers.get("x-seen")).toBe("1");
      expect(ok.headers.get("HORS-Result")).toBeTruthy();
    });
  });

  it("surfaces a custom challenge from middleware", async () => {
    await withTempHome(async (home) => {
      const { gate } = await testGate(home, { origins: ["https://work.example.com"] });
      const paid = await hors(
        {
          origin: "public",
          use: async (ctx) => ctx.deny("pay", { code: "OVER_BUDGET", challenge: { price: 1 } }),
        },
        { gate },
      );
      const denied = await paid.handle(
        new Request("https://work.example.com/approve", { method: "POST" }),
        () => new Response("no"),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        code: "OVER_BUDGET",
        challenge: { price: 1 },
      });
    });
  });

  it("rejects gate plus a config key, an unknown policy, and maxBodyBytes 0", async () => {
    await withTempHome(async (home) => {
      const { gate } = await testGate(home);
      await expect(hors(undefined, { gate, fn: "POST /approve" })).resolves.toBeTruthy();
      await expect(hors("public", { gate, profile: "x" })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      await expect(hors("no-such-policy")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(hors("public", { gate, maxBodyBytes: 0 })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
    });
  });

  it("passes HORS-Meta through to ctx.meta", async () => {
    await withTempHome(async (home) => {
      const { gate, account } = await testGate(home, { origins: ["https://work.example.com"] });
      const guard = await hors("public", { gate });
      const signer = await createSigner({
        account,
        fetch: (input, init) =>
          guard.handle(new Request(input, init), (_request, ctx) =>
            Response.json({ meta: ctx.meta }),
          ),
      });
      const response = await signer.fetch("https://work.example.com/approve", {
        method: "POST",
        meta: { note: "hi" },
      });
      expect(await response.json()).toEqual({ meta: { note: "hi" } });
    });
  });

  it("omits a route that was gated without fn from published()", async () => {
    await withTempHome(async (home) => {
      const { gate } = await testGate(home, { origins: ["https://work.example.com"] });
      const listed = await hors("public", { gate, fn: "POST /approve" });
      await hors("public", { gate });
      expect(listed.published().functions.map((entry) => entry.fn)).toEqual(["POST /approve"]);
    });
  });

  it("derives the expected host from request.url when no origins are configured", async () => {
    await withTempHome(async (home) => {
      const { gate, account } = await testGate(home);
      const guard = await hors("public", { gate });
      const signer = await createSigner({ account });
      const envelope = await signer.sign({
        url: "https://work.example.com/approve",
        fn: "POST /approve",
        argsHash: ZERO_HASH,
      });
      const { encodeHeaderJson } = await import("../src/http/envelope-header.js");
      const ok = await guard.handle(
        new Request("https://work.example.com/approve", {
          method: "POST",
          headers: { "HORS-Authorization": encodeHeaderJson(envelope) },
        }),
        echoHandler,
      );
      expect(ok.status).toBe(200);
      const other = await signer.sign({
        url: "https://other.example.com/approve",
        fn: "POST /approve",
        argsHash: ZERO_HASH,
      });
      const mismatch = await guard.handle(
        new Request("https://work.example.com/approve", {
          method: "POST",
          headers: { "HORS-Authorization": encodeHeaderJson(other) },
        }),
        echoHandler,
      );
      expect(await mismatch.json()).toMatchObject({ code: "HORS_DOMAIN_MISMATCH" });
    });
  });

  it("lists declared functions and rejects a duplicate or unnormalised fn", async () => {
    await withTempHome(async (home) => {
      const { gate } = await testGate(home, {
        origins: ["https://work.example.com"],
        functions: { "GET /report": "public" },
      });
      const approve = await hors("same-human", { gate, fn: "POST /approve" });
      const report = await hors(undefined, { gate, fn: "GET /report" });
      expect(approve.published()).toEqual(report.published());
      expect(approve.published().functions.map((entry) => entry.fn)).toEqual([
        "GET /report",
        "POST /approve",
      ]);
      expect(approve.published().functions[0]?.policy.name).toBe("public");
      expect(approve.published().functions[1]?.policy.name).toBe("same-human");
      await expect(hors("public", { gate, fn: "POST /approve" })).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
      await expect(hors("public", { gate, fn: "post /approve/" })).rejects.toSatisfy((error) => {
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
    });
  });
});
