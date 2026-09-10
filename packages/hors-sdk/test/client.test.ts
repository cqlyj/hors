import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSigner } from "../src/client/index.js";
import { parseEnvelope } from "../src/envelope.js";
import { HorsError } from "../src/errors.js";
import { hashArgs } from "../src/hash.js";
import { hors } from "../src/mcp/index.js";
import { closeMcpPairs, testGate, trackMcpClose } from "./helpers/mcp.js";
import { withTempDir } from "./helpers/tmp.js";

const amountSchema = z.object({ amount: z.number() });

afterEach(async () => {
  await closeMcpPairs();
  vi.unstubAllEnvs();
});

async function writeKeyProfile(
  home: string,
  name: string,
  key: `0x${string}`,
  extras?: { humanId?: string; mode?: number },
): Promise<void> {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "key"), `${key}\n`, { mode: extras?.mode ?? 0o600 });
  const account = privateKeyToAccount(key);
  await writeFile(
    join(dir, "profile.json"),
    JSON.stringify({
      address: account.address,
      ...(extras?.humanId === undefined ? {} : { humanId: extras.humanId }),
    }),
  );
}

describe("createSigner", () => {
  it("builds a signer from an account with a null humanId", async () => {
    await withTempDir(async (home) => {
      vi.stubEnv("HORS_HOME", home);
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = await createSigner({ account });
      expect(signer.address).toBe(account.address.toLowerCase());
      expect(signer.humanId).toBeNull();
    });
  });

  it("keeps humanId null when account is set and HORS_HOME is unreadable", async () => {
    await withTempDir(async (home) => {
      vi.stubEnv("HORS_HOME", join(home, "missing-as-file"));
      await writeFile(join(home, "missing-as-file"), "not-a-dir");
      const account = privateKeyToAccount(generatePrivateKey());
      const signer = await createSigner({ account });
      expect(signer.humanId).toBeNull();
    });
  });

  it("throws CONFIG_INVALID when a key file is paired with a corrupt profile.json", async () => {
    await withTempDir(async (home) => {
      const key = generatePrivateKey();
      vi.stubEnv("HORS_HOME", home);
      await writeKeyProfile(home, "default", key);
      await writeFile(join(home, "default", "profile.json"), "{");
      await expect(createSigner()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });
  });

  it("reads the key file and the profile pin", async () => {
    await withTempDir(async (home) => {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      vi.stubEnv("HORS_HOME", home);
      await writeKeyProfile(home, "default", key, {
        humanId: "0x000000000000000000000000000000000000000000000000000000000000000a",
      });
      const signer = await createSigner();
      expect(signer.address).toBe(account.address.toLowerCase());
      expect(signer.humanId).toBe(
        "0x000000000000000000000000000000000000000000000000000000000000000a",
      );
    });
  });

  it.skipIf(process.platform === "win32")("rejects a key file that is not mode 0600", async () => {
    await withTempDir(async (home) => {
      vi.stubEnv("HORS_HOME", home);
      await writeKeyProfile(home, "default", generatePrivateKey(), { mode: 0o644 });
      await expect(createSigner()).rejects.toSatisfy((error) => {
        expect(error).toBeInstanceOf(HorsError);
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        expect((error as HorsError).message).toContain("0600");
        return true;
      });
    });
  });

  it("throws PROFILE_NOT_FOUND with a connect hint when no key exists", async () => {
    await withTempDir(async (home) => {
      vi.stubEnv("HORS_HOME", home);
      vi.stubEnv("HORS_PROFILE", "agent");
      await expect(createSigner()).rejects.toSatisfy((error) => {
        expect((error as HorsError).code).toBe("PROFILE_NOT_FOUND");
        expect((error as HorsError).message).toContain("npx -y hors-cli connect --profile agent");
        return true;
      });
    });
  });

  it("uses HORS_PRIVATE_KEY when no key file is present", async () => {
    await withTempDir(async (home) => {
      const key = generatePrivateKey();
      vi.stubEnv("HORS_HOME", home);
      vi.stubEnv("HORS_PRIVATE_KEY", key);
      const signer = await createSigner();
      expect(signer.address).toBe(privateKeyToAccount(key).address.toLowerCase());
    });
  });

  it("rejects an invalid profile name and a zero expiry", async () => {
    await withTempDir(async (home) => {
      vi.stubEnv("HORS_HOME", home);
      await expect(
        createSigner({ profile: "../x", account: privateKeyToAccount(generatePrivateKey()) }),
      ).rejects.toSatisfy((error) => {
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
      await expect(
        createSigner({ account: privateKeyToAccount(generatePrivateKey()), expirySeconds: 0 }),
      ).rejects.toSatisfy((error) => {
        expect((error as HorsError).code).toBe("CONFIG_INVALID");
        return true;
      });
    });
  });

  it("builds an envelope that the gate accepts byte-for-byte", async () => {
    await withTempDir(async (home) => {
      vi.stubEnv("HORS_HOME", home);
      const { gate, account } = await testGate(home, {
        origins: ["https://work.example.com:8443/mcp"],
      });
      const signer = await createSigner({ account, expirySeconds: 90 });
      const argsHash = await hashArgs({ amount: 1 });
      const first = await signer.sign({
        url: "https://work.example.com:8443/mcp?x=1",
        fn: "same",
        argsHash,
      });
      const parsed = parseEnvelope(first);
      expect(parsed.domain).toBe("work.example.com");
      expect(parsed.uri).toBe("https://work.example.com:8443/mcp");
      expect(Date.parse(parsed.expirationTime) - Date.parse(parsed.issuedAt)).toBe(90_000);
      const defaults = await createSigner({ account });
      const def = await defaults.sign({
        url: "https://work.example.com:8443/mcp",
        fn: "same",
        argsHash,
      });
      expect(Date.parse(def.expirationTime) - Date.parse(def.issuedAt)).toBe(120_000);
      const second = await signer.sign({
        url: "https://work.example.com:8443/mcp?x=1",
        fn: "same",
        argsHash,
      });
      expect(second.nonce).not.toBe(first.nonce);
      expect(second.requestId).not.toBe(first.requestId);
      const decision = await gate.evaluate({
        fn: "same",
        args: { amount: 1 },
        envelope: first,
        transport: "http",
        local: false,
        url: { host: "work.example.com:8443", forwardedHost: undefined, path: "/mcp" },
      });
      expect(decision.ok).toBe(true);
      await expect(
        signer.sign({ url: "https://work.example.com/mcp", fn: "same", argsHash: "abc" }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(
        signer.sign({
          url: "https://user:pass@work.example.com/mcp",
          fn: "same",
          argsHash,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(
        signer.sign({ url: "http://[::1]/mcp", fn: "same", argsHash }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });
  });

  async function wrapPair(home: string) {
    vi.stubEnv("HORS_HOME", home);
    const { gate, account } = await testGate(home, {
      origins: ["https://work.example.com/mcp"],
    });
    const signer = await createSigner({
      account,
      meta: (call) => ({ seen: call }),
    });
    let seenMeta: unknown;
    const server = await hors(new McpServer({ name: "hors-test", version: "1.0.0" }), {
      gate,
      transport: "http",
    });
    server.registerTool("same", { inputSchema: amountSchema }, (_args, ctx) => {
      seenMeta = ctx.hors.meta;
      expect(ctx.hors.callerAddress).toBe(signer.address);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = vi.spyOn(clientTransport, "send");
    const wrapped = signer.wrapTransport(clientTransport, {
      url: "https://work.example.com/mcp",
    });
    const client = new Client({ name: "hors-test-client", version: "1.0.0" });
    trackMcpClose(async () => {
      await client.close();
      await server.close();
    });
    await Promise.all([client.connect(wrapped), server.connect(serverTransport)]);
    return { client, send, seen: () => seenMeta };
  }

  it("attaches hors/auth only to tools/call, not tools/list", async () => {
    await withTempDir(async (home) => {
      const { client, send } = await wrapPair(home);
      await client.callTool({ name: "same", arguments: { amount: 1 } });
      const sent = send.mock.calls.map(([message]) => message);
      const calls = sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          message.method === "tools/call",
      );
      const lists = sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          message.method === "tools/list",
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(
        calls.every(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "params" in message &&
            (message.params as { _meta?: { "hors/auth"?: unknown } })._meta?.["hors/auth"] !==
              undefined,
        ),
      ).toBe(true);
      expect(
        lists.every(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "params" in message &&
            (message.params as { _meta?: { "hors/auth"?: unknown } } | undefined)?._meta?.[
              "hors/auth"
            ] === undefined,
        ),
      ).toBe(true);
    });
  });

  it("does not mutate the caller's params and forwards signer meta", async () => {
    await withTempDir(async (home) => {
      const { client, seen } = await wrapPair(home);
      const args = { amount: 1 };
      const params = { name: "same", arguments: args };
      const result = await client.callTool(params);
      expect(result.isError).not.toBe(true);
      expect(params).toEqual({ name: "same", arguments: args });
      expect(seen()).toEqual({
        seen: {
          url: "https://work.example.com/mcp",
          fn: "same",
          argsHash: await hashArgs(args),
        },
      });
    });
  });

  it("rejects tools/call arguments that hashArgs cannot canonicalise", async () => {
    await withTempDir(async (home) => {
      const { client } = await wrapPair(home);
      await expect(
        client.callTool({ name: "same", arguments: { amount: 1n as never } }),
      ).rejects.toBeInstanceOf(HorsError);
    });
  });
});
