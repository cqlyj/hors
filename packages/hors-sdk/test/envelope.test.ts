import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/envelope.js";
import { HorsError } from "../src/errors.js";

const ARGS_URN =
  "urn:hors:args:sha256:f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab";

function samplePayload(): Record<string, unknown> {
  return {
    domain: "work.example.com",
    address: "0xAbC0000000000000000000000000000000000001",
    statement: "HORS v1 call",
    uri: "https://work.example.com/mcp",
    version: "1",
    chainId: "eip155:480",
    type: "eip191",
    nonce: "k3Jd8sPq2ZxVb7Nm1Rt4Yw",
    issuedAt: "2026-09-08T02:15:30.123Z",
    expirationTime: "2026-09-08T02:17:30.123Z",
    requestId: "6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f",
    resources: ["urn:hors:v:1", "urn:hors:fn:approveTravelExpense", ARGS_URN],
    signature: `0x${"11".repeat(65)}`,
  };
}

function mutate(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...samplePayload(), ...patch };
}

function expectBadField(raw: unknown, field: string, banned?: string): void {
  try {
    parseEnvelope(raw);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
    expect((error as HorsError).message).toContain(field);
    if (banned !== undefined) {
      expect((error as HorsError).message).not.toContain(banned);
    }
  }
}

describe("parseEnvelope", () => {
  it("parses the sample payload and drops unknown fields", () => {
    const parsed = parseEnvelope({ ...samplePayload(), foo: "bar" });
    expect(parsed).toEqual({
      domain: "work.example.com",
      address: "0xAbC0000000000000000000000000000000000001",
      statement: "HORS v1 call",
      uri: "https://work.example.com/mcp",
      version: "1",
      chainId: "eip155:480",
      type: "eip191",
      nonce: "k3Jd8sPq2ZxVb7Nm1Rt4Yw",
      issuedAt: "2026-09-08T02:15:30.123Z",
      expirationTime: "2026-09-08T02:17:30.123Z",
      requestId: "6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f",
      resources: ["urn:hors:v:1", "urn:hors:fn:approveTravelExpense", ARGS_URN],
      signature: `0x${"11".repeat(65)}`,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "address",
      "chainId",
      "domain",
      "expirationTime",
      "issuedAt",
      "nonce",
      "requestId",
      "resources",
      "signature",
      "statement",
      "type",
      "uri",
      "version",
    ]);
    expect("notBefore" in parsed).toBe(false);
    expect("foo" in parsed).toBe(false);
  });

  it("rejects each envelope constraint violation without echoing the bad value", () => {
    expectBadField(mutate({ statement: "HORS v2 call" }), "statement", "HORS v2 call");
    expectBadField(mutate({ version: "2" }), "version", "2");
    expectBadField(
      mutate({ notBefore: "2026-09-08T02:15:30.123Z" }),
      "notBefore",
      "2026-09-08T02:15:30.123Z",
    );
    expectBadField(mutate({ nonce: "k3Jd8sPq2ZxVb7N" }), "nonce", "k3Jd8sPq2ZxVb7N");
    expectBadField(mutate({ nonce: "a".repeat(129) }), "nonce", "aaa");
    expectBadField(mutate({ nonce: "k3Jd8sPq2ZxVb7Nm1Rt-Yw" }), "nonce", "k3Jd8sPq2ZxVb7Nm1Rt-Yw");
    expectBadField(
      mutate({ requestId: "6F1C2A3E-8B4D-4C5E-9F60-1A2B3C4D5E6F" }),
      "requestId",
      "6F1C2A3E-8B4D-4C5E-9F60-1A2B3C4D5E6F",
    );
    expectBadField(
      mutate({ requestId: "6f1c2a3e-8b4d-1c5e-9f60-1a2b3c4d5e6f" }),
      "requestId",
      "6f1c2a3e-8b4d-1c5e-9f60-1a2b3c4d5e6f",
    );
    const missingRequestId = samplePayload();
    delete missingRequestId.requestId;
    expectBadField(missingRequestId, "requestId");
    expectBadField(
      mutate({
        resources: ["urn:hors:v:1", "urn:hors:fn:approveTravelExpense"],
      }),
      "resources",
      "approveTravelExpense",
    );
    expectBadField(
      mutate({
        resources: ["urn:hors:v:1", "urn:hors:fn:approveTravelExpense", ARGS_URN, "urn:hors:v:1"],
      }),
      "resources",
      "approveTravelExpense",
    );
    expectBadField(
      mutate({
        resources: ["urn:hors:v:1", ARGS_URN, "urn:hors:fn:approveTravelExpense"],
      }),
      "resources",
      ARGS_URN,
    );
    expectBadField(
      mutate({
        resources: ["urn:hors:v:x", "urn:hors:fn:approveTravelExpense", ARGS_URN],
      }),
      "resources",
      "urn:hors:v:x",
    );
    expectBadField(
      mutate({
        resources: [
          "urn:hors:v:1",
          "urn:hors:fn:approveTravelExpense",
          ARGS_URN.replace("f179", "F179"),
        ],
      }),
      "resources",
      "F179",
    );
    expectBadField(mutate({ type: "ed25519" }), "type", "ed25519");
    expectBadField(mutate({ signatureScheme: "siws" }), "signatureScheme", "siws");
    expectBadField(mutate({ chainId: "480" }), "chainId", "480");
    expectBadField(mutate({ chainId: "eip155:0" }), "chainId", "eip155:0");
    expectBadField(
      mutate({ chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }),
      "chainId",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    );
    expectBadField(mutate({ uri: "https://work.example.com/mcp?x=1" }), "uri", "?x=1");
    expectBadField(mutate({ uri: "https://work.example.com/mcp#frag" }), "uri", "#frag");
    expectBadField(mutate({ uri: "mailto:a@b" }), "uri", "mailto:a@b");
    expectBadField(mutate({ uri: "not a url" }), "uri", "not a url");
    expectBadField(mutate({ address: `0x${"a".repeat(39)}` }), "address", "aaa");
    expectBadField(mutate({ domain: "work.example.com:443" }), "domain", "work.example.com:443");
    expectBadField(mutate({ domain: "work.example.com/mcp" }), "domain", "work.example.com/mcp");
    expectBadField(
      mutate({ issuedAt: "2026-09-08T02:15:30Z" }),
      "issuedAt",
      "2026-09-08T02:15:30Z",
    );
    expectBadField(
      mutate({ issuedAt: "2026-13-45T00:00:00.000Z" }),
      "issuedAt",
      "2026-13-45T00:00:00.000Z",
    );
    const missingExpiration = samplePayload();
    delete missingExpiration.expirationTime;
    expectBadField(missingExpiration, "expirationTime");
    try {
      parseEnvelope(mutate({ signature: "0x" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
      expect((error as HorsError).message).toBe(
        "bad envelope: signature must be 0x-prefixed even-length hex",
      );
    }
    expectBadField(mutate({ signature: "0xabc" }), "signature", "0xabc");
    expectBadField(mutate({ signature: "deadbeef" }), "signature", "deadbeef");
    expectBadField(mutate({ uri: "https://work.example.com/mcp\r\nNonce: x" }), "uri", "Nonce: x");
    try {
      parseEnvelope(mutate({ uri: "https://u:p@work.example.com/mcp" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).message).toBe(
        "bad envelope: uri must be an http(s) URL without userinfo, query or fragment",
      );
    }
    expectBadField(mutate({ uri: "https://work.example.com/mcp%zz" }), "uri", "%zz");
    expectBadField(mutate({ uri: "https://work.example.com\\mcp" }), "uri", "\\mcp");
    expectBadField(mutate({ uri: `https://work.example.com/${"a".repeat(2024)}` }), "uri", "aaa");
    expectBadField(mutate({ domain: "myhost" }), "domain", "myhost");
    expectBadField(mutate({ domain: "a..b" }), "domain", "a..b");
    expectBadField(mutate({ domain: "999.1.1.1" }), "domain", "999.1.1.1");
    expectBadField(mutate({ domain: "example.c0m" }), "domain", "example.c0m");
    expectBadField(mutate({ chainId: "eip155:9007199254740992" }), "chainId", "9007199254740992");
    expectBadField(mutate({ signature: `0x${"11".repeat(64)}` }), "signature", "1111");
    expectBadField(mutate({ signature: `0x${"11".repeat(66)}` }), "signature", "1111");
    expectBadField(
      mutate({ type: "eip1271", signature: `0x${"11".repeat(32_769)}` }),
      "signature",
      "1111",
    );
    expectBadField(
      mutate({
        resources: ["urn:hors:v:1", `urn:hors:fn:${"a".repeat(2037)}`, ARGS_URN],
      }),
      "resources",
      "aaa",
    );
  });

  it("accepts viem-compatible domains, URIs, chain ids and signature sizes", () => {
    expect(parseEnvelope(mutate({ uri: "HTTPS://WORK.EXAMPLE.COM/mcp" })).uri).toBe(
      "HTTPS://WORK.EXAMPLE.COM/mcp",
    );
    expect(parseEnvelope(mutate({ uri: "https://work.example.com/mcp%3F" })).uri).toBe(
      "https://work.example.com/mcp%3F",
    );
    expect(parseEnvelope(mutate({ domain: "localhost" })).domain).toBe("localhost");
    expect(parseEnvelope(mutate({ domain: "127.0.0.1" })).domain).toBe("127.0.0.1");
    expect(parseEnvelope(mutate({ chainId: "eip155:9007199254740991" })).chainId).toBe(
      "eip155:9007199254740991",
    );
    expect(parseEnvelope(mutate({ signature: `0x${"11".repeat(65)}` })).signature).toHaveLength(
      132,
    );
    expect(
      parseEnvelope(mutate({ type: "eip1271", signature: `0x${"11".repeat(200)}` })).signature,
    ).toHaveLength(402);
  });

  it("rejects non-objects and a payload missing address at the AgentKit schema step", () => {
    expectBadField(null, "schema");
    expectBadField("envelope", "schema");
    expectBadField([], "resources");
    const missingAddress = samplePayload();
    delete missingAddress.address;
    expectBadField(missingAddress, "address");
  });

  it("accepts any eip155 chain id and an eip6492 scheme hint", () => {
    expect(parseEnvelope(mutate({ chainId: "eip155:1" })).chainId).toBe("eip155:1");
    const parsed = parseEnvelope(mutate({ type: "eip1271", signatureScheme: "eip6492" }));
    expect(parsed.type).toBe("eip1271");
    expect(parsed.signatureScheme).toBe("eip6492");
  });

  it("rejects a throwing envelope as HORS_BAD_ENVELOPE without echoing the cause", () => {
    expectBadField(
      new Proxy(
        {},
        {
          get() {
            throw new Error("boom");
          },
        },
      ),
      "envelope",
      "boom",
    );
    try {
      parseEnvelope({
        get domain() {
          throw new Error("boom");
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
      expect((error as HorsError).message).not.toContain("boom");
    }
  });

  it("rejects a resources array that is not exactly three URNs before schema validation", () => {
    expectBadField(mutate({ resources: new Array(10_000).fill("x") }), "resources");
  });
});
