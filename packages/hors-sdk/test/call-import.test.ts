import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "./helpers/tmp.js";

vi.mock("@modelcontextprotocol/client", () => {
  throw new Error("not installed");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Signer.call without the MCP client package", () => {
  it("throws CONFIG_INVALID pointing at fetch()", async () => {
    await withTempHome(async () => {
      const { createSigner } = await import("../src/client/index.js");
      const signer = await createSigner({
        account: privateKeyToAccount(generatePrivateKey()),
        fetch: async () => new Response(),
      });
      await expect(signer.call("https://work.example.com/mcp", "same", {})).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("fetch()"),
      });
    });
  });
});
