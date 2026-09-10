/** biome-ignore-all lint/suspicious/noExplicitAny: express 5.x ships no types of its own */
import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSigner } from "../src/client/index.js";
import { hashBody } from "../src/hash.js";
import { encodeHeaderJson } from "../src/http/envelope-header.js";
import { hors } from "../src/http/index.js";
import { testGate } from "./helpers/mcp.js";
import { withTempHome } from "./helpers/tmp.js";

// @ts-expect-error express 5.x ships no types of its own
const express = (await import("express")).default as any;

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(app: any): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("hors HTTP Express integration", () => {
  it("serves a signed POST and refuses an unsigned one", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, account } = await testGate(home, { origins: [url] });
      const guard = await hors("same-human", { gate, fn: "POST /approve" });
      app.post("/approve", guard.express(), (req: any, res: any) => {
        expect(Object.keys(req).includes("hors")).toBe(true);
        res.json({ human: req.hors.callerHumanId, raw: req.rawBody.length });
      });
      const signer = await createSigner({ account });
      const ok = await signer.fetch(`${url}/approve`, {
        method: "POST",
        body: '{"n":1}',
        headers: { "content-type": "application/json" },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("HORS-Result")).toBeTruthy();
      expect(await ok.json()).toEqual({ human: gate.owner(), raw: 7 });

      const unsigned = await fetch(`${url}/approve`, { method: "POST", body: '{"n":1}' });
      expect(unsigned.status).toBe(401);
    });
  });

  it("uses originalUrl under an Express mount", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, account } = await testGate(home, { origins: [url] });
      const guard = await hors("public", { gate, fn: "POST /api/approve" });
      const router = express.Router();
      router.post("/approve", guard.express(), (req: any, res: any) => {
        res.json({ fn: req.hors.fn });
      });
      app.use("/api", router);
      const signer = await createSigner({ account });
      const ok = await signer.fetch(`${url}/api/approve`, { method: "POST" });
      expect(await ok.json()).toEqual({ fn: "POST /api/approve" });
    });
  });

  it("fails closed when express.json() consumed the body without rawBody", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, logs } = await testGate(home, { origins: [url] });
      const guard = await hors("public", { gate });
      app.use(express.json());
      app.post("/approve", guard.express(), (_req: any, res: any) => res.json({ ok: true }));
      const response = await fetch(`${url}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":1}',
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "HORS_POLICY_ERROR" });
      expect(
        logs.some((event) => String(event.message).includes("consumed before the guard ran")),
      ).toBe(true);
    });
  });

  it("accepts a body parser that keeps req.rawBody", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, account } = await testGate(home, { origins: [url] });
      const guard = await hors("same-human", { gate });
      app.use(
        express.json({
          verify: (req: any, _res: unknown, buf: Uint8Array) => {
            req.rawBody = buf;
          },
        }),
      );
      app.post("/approve", guard.express(), (req: any, res: any) => {
        res.json({ raw: req.rawBody.length });
      });
      const signer = await createSigner({ account });
      const ok = await signer.fetch(`${url}/approve`, {
        method: "POST",
        body: '{"n":1}',
        headers: { "content-type": "application/json" },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ raw: 7 });
    });
  });

  it("buffers a middleware policy response and preserves status and body", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, account } = await testGate(home, { origins: [url] });
      const guard = await hors(
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
      app.post("/approve", guard.express(), (_req: any, res: any) => {
        res.status(201).json({ ok: true });
      });
      const signer = await createSigner({ account });
      const ok = await signer.fetch(`${url}/approve`, { method: "POST" });
      expect(ok.status).toBe(201);
      expect(ok.headers.get("x-seen")).toBe("1");
      expect(ok.headers.get("HORS-Result")).toBeTruthy();
      expect(await ok.json()).toEqual({ ok: true });
    });
  });

  it("fails closed when a data listener consumed the stream before the guard", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, logs } = await testGate(home, { origins: [url] });
      const guard = await hors("public", { gate });
      app.use((req: any, _res: any, next: any) => {
        req.once("data", () => next());
      });
      app.post("/approve", guard.express(), (_req: any, res: any) => res.json({ ok: true }));
      const response = await fetch(`${url}/approve`, { method: "POST", body: "hello" });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "HORS_POLICY_ERROR" });
      expect(
        logs.some((event) => String(event.message).includes("consumed before the guard ran")),
      ).toBe(true);
    });
  });

  it("buffers hex-encoded writes as the decoded bytes", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, account } = await testGate(home, { origins: [url] });
      const guard = await hors(
        {
          origin: "public",
          use: async (_ctx, next) => next(),
        },
        { gate },
      );
      app.post("/approve", guard.express(), (_req: any, res: any) => {
        const patched = res.write;
        res.setHeader("content-type", "text/plain");
        res.end("48656c6c6f", "hex");
        expect(res.write).not.toBe(patched);
      });
      const signer = await createSigner({ account });
      const ok = await signer.fetch(`${url}/approve`, { method: "POST" });
      expect(await ok.text()).toBe("Hello");
    });
  });

  it("settles the buffer and restores write/end/writeHead when the client destroys the request", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, audits } = await testGate(home, { origins: [url] });
      const guard = await hors(
        {
          origin: "public",
          use: async (_ctx, next) => next(),
        },
        { gate },
      );
      let patchedWrite: unknown;
      let resRef: { write: unknown } | undefined;
      const hit = new Promise<void>((resolve) => {
        app.post("/approve", guard.express(), (req: any, res: any) => {
          patchedWrite = res.write;
          resRef = res;
          req.destroy();
          resolve();
        });
      });
      const ac = new AbortController();
      const pending = fetch(`${url}/approve`, {
        method: "POST",
        body: "x",
        signal: ac.signal,
      }).catch(() => undefined);
      await hit;
      ac.abort();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await pending;
      expect(audits).toEqual([expect.objectContaining({ status: "ok" })]);
      expect(resRef?.write).not.toBe(patchedWrite);
    });
  });

  it("hashes the bytes a GET actually carried on the Express path", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate, account } = await testGate(home, { origins: [url] });
      const guard = await hors("same-human", { gate, fn: "GET /approve" });
      app.get("/approve", guard.express(), (_req: any, res: any) => {
        res.json({ ok: true });
      });
      const body = '{"n":1}';
      const bytes = new TextEncoder().encode(body);
      const signer = await createSigner({ account });
      const parsed = new URL(`${url}/approve`);
      const signUrl = parsed.origin + parsed.pathname;
      const send = async (argsHash: string): Promise<{ status: number; body: string }> => {
        const envelope = await signer.sign({ url: signUrl, fn: "GET /approve", argsHash });
        return new Promise((resolve, reject) => {
          const req = request(
            `${url}/approve`,
            {
              method: "GET",
              headers: {
                "HORS-Authorization": encodeHeaderJson(envelope),
                "content-type": "application/json",
                "content-length": String(bytes.byteLength),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk) => {
                chunks.push(chunk);
              });
              res.on("end", () => {
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                });
              });
            },
          );
          req.on("error", reject);
          req.write(body);
          req.end();
        });
      };
      const ok = await send(await hashBody(bytes));
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toEqual({ ok: true });
      const mismatch = await send(await hashBody(new Uint8Array()));
      expect(mismatch.status).toBe(403);
      expect(JSON.parse(mismatch.body)).toMatchObject({ code: "HORS_ARGS_MISMATCH" });
    });
  });

  it("serves the well-known document and rejects non-GET", async () => {
    await withTempHome(async (home) => {
      const app = express();
      const url = await listen(app);
      const { gate } = await testGate(home, { origins: [url] });
      const guard = await hors("same-human", { gate, fn: "POST /approve" });
      app.use("/.well-known/hors.json", guard.wellKnown());
      const listed = await fetch(`${url}/.well-known/hors.json`);
      expect(listed.status).toBe(200);
      expect(listed.headers.get("content-type")).toContain("application/json");
      const body = (await listed.json()) as { v: number; functions: Array<{ fn: string }> };
      expect(body.v).toBe(1);
      expect(body.functions[0]?.fn).toBe("POST /approve");
      const posted = await fetch(`${url}/.well-known/hors.json`, { method: "POST" });
      expect(posted.status).toBe(405);
    });
  });
});
