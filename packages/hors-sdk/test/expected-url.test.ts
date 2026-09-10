import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/envelope.js";
import { HorsError } from "../src/errors.js";
import { expectedUrls, matchExpectedUrl } from "../src/verify/expected-url.js";

const ARGS_URN =
  "urn:hors:args:sha256:f17960914cd004d608dcb3db98e182e300e3661f34543015d66ae678c150c5ab";

function sampleEnvelope() {
  return parseEnvelope({
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
}

describe("expected URL", () => {
  it("derives host and path from the Host header", () => {
    expect(
      expectedUrls(
        { host: "Work.Example.com", forwardedHost: undefined, path: "/mcp/" },
        {
          trustProxy: false,
        },
      ),
    ).toEqual([{ host: "work.example.com", path: "/mcp" }]);
  });

  it("uses the first X-Forwarded-Host value only when trustProxy is set", () => {
    const location = {
      host: "work.example.com",
      forwardedHost: "a.example, b.example",
      path: "/mcp",
    };
    expect(expectedUrls(location, { trustProxy: true })).toEqual([
      { host: "a.example", path: "/mcp" },
    ]);
    expect(expectedUrls(location, { trustProxy: false })).toEqual([
      { host: "work.example.com", path: "/mcp" },
    ]);
  });

  it("fails closed when the host cannot be derived", () => {
    try {
      expectedUrls(
        { host: undefined, forwardedHost: undefined, path: "/mcp" },
        {
          trustProxy: false,
        },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_DOMAIN_MISMATCH");
      expect((error as HorsError).message).toBe(
        "expected URL could not be derived; configure origins",
      );
    }
  });

  it("lets configured origins replace request derivation", () => {
    const evil = { host: "evil.example", forwardedHost: undefined, path: "/other" };
    expect(
      expectedUrls(evil, { trustProxy: false, origins: ["https://work.example.com/mcp"] }),
    ).toEqual([{ host: "work.example.com", path: "/mcp" }]);

    expect(
      expectedUrls(
        { host: "ignored.example", forwardedHost: undefined, path: "/v1/approve/" },
        { trustProxy: false, origins: ["https://api.example.com"] },
      ),
    ).toEqual([{ host: "api.example.com", path: "/v1/approve" }]);

    expect(
      expectedUrls(
        { host: "ignored.example", forwardedHost: undefined, path: "/from-request" },
        { trustProxy: false, origins: ["https://x.example:8443/mcp/", "http://y.example"] },
      ),
    ).toEqual([
      { host: "x.example:8443", path: "/mcp" },
      { host: "y.example", path: "/from-request" },
    ]);
  });

  it("matches the sample envelope against the derived URL", () => {
    const envelope = sampleEnvelope();
    const expected = [{ host: "work.example.com", path: "/mcp" }];
    expect(() => matchExpectedUrl(envelope, expected)).not.toThrow();
    expect(() =>
      matchExpectedUrl({ ...envelope, uri: "https://work.example.com/mcp/" }, expected),
    ).not.toThrow();
    expect(() =>
      matchExpectedUrl(envelope, [
        { host: "other.example.com", path: "/mcp" },
        { host: "work.example.com", path: "/mcp" },
      ]),
    ).not.toThrow();
  });

  it("rejects host, path, port and domain mismatches with a bounded reason", () => {
    const envelope = sampleEnvelope();
    const mismatches = [
      [{ host: "other.example.com", path: "/mcp" }],
      [{ host: "work.example.com", path: "/mcp2" }],
      [{ host: "work.example.com:8443", path: "/mcp" }],
    ] as const;
    for (const expected of mismatches) {
      expect(() => matchExpectedUrl(envelope, expected)).toThrowError(
        expect.objectContaining({ code: "HORS_DOMAIN_MISMATCH" }),
      );
    }
    expect(() =>
      matchExpectedUrl({ ...envelope, domain: "example.com" }, [
        { host: "work.example.com", path: "/mcp" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "HORS_DOMAIN_MISMATCH" }));

    try {
      matchExpectedUrl(envelope, [{ host: "work.example.com", path: "/mcp2" }]);
      expect.unreachable();
    } catch (error) {
      expect((error as HorsError).message).toContain("work.example.com/mcp2");
      expect((error as HorsError).message).toContain("work.example.com/mcp");
    }

    const longPath = `/${"a".repeat(2000)}`;
    try {
      matchExpectedUrl({ domain: "work.example.com", uri: `https://work.example.com${longPath}` }, [
        { host: "work.example.com", path: "/mcp" },
      ]);
      expect.unreachable();
    } catch (error) {
      expect((error as HorsError).code).toBe("HORS_DOMAIN_MISMATCH");
      expect((error as HorsError).message.length).toBeLessThanOrEqual(1024);
    }
  });

  it("does not throw anything but HORS_DOMAIN_MISMATCH for an IPv6 entry", () => {
    try {
      matchExpectedUrl({ domain: "localhost", uri: "https://localhost/mcp" }, [
        { host: "[::1]:3000", path: "/mcp" },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_DOMAIN_MISMATCH");
    }
  });
});
