import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { HorsError } from "../src/errors.js";

function bitsToNumber(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

function utf8Hex(text: string): string {
  return [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function expectBadEnvelope(value: unknown): void {
  expect(() => canonicalJson(value)).toThrowError(
    expect.objectContaining({ code: "HORS_BAD_ENVELOPE" }),
  );
}

describe("canonicalJson (RFC 8785)", () => {
  it("sorts object members by UTF-16 code units", () => {
    const expected = '{"amount":850,"currency":"EUR"}';
    expect(canonicalJson({ currency: "EUR", amount: 850 })).toBe(expected);
    expect(canonicalJson({ amount: 850, currency: "EUR" })).toBe(expected);
  });

  it("matches the RFC 8785 §3.2.2 sample and its UTF-8 hex", () => {
    const numbers = JSON.parse("[333333333.33333329, 1e30, 4.5, 2e-3, 1e-27]");
    const sample = {
      numbers,
      string: '\u20ac$\u000F\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    const canonical = canonicalJson(sample);
    expect(canonical).toBe(
      `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":${JSON.stringify(sample.string)}}`,
    );
    expect(utf8Hex(canonical)).toBe(
      "7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b3333333333333333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d",
    );
  });

  it("sorts the RFC 8785 §3.2.3 key vector in UTF-16 code-unit order", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    const expected = [
      ["\r", "Carriage Return"],
      ["1", "One"],
      ["\u0080", "Control"],
      ["\u00f6", "Latin Small Letter O With Diaeresis"],
      ["\u20ac", "Euro Sign"],
      ["\ud83d\ude00", "Emoji: Grinning Face"],
      ["\ufb33", "Hebrew Letter Dalet With Dagesh"],
    ]
      .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
      .join(",");
    expect(canonicalJson(input)).toBe(`{${expected}}`);
  });

  it("matches the RFC 8785 Appendix B number vectors", () => {
    const vectors: Array<[string, string]> = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ];
    for (const [bits, expected] of vectors) {
      expect(canonicalJson(bitsToNumber(bits))).toBe(expected);
    }
    expectBadEnvelope(bitsToNumber("7fffffffffffffff"));
    expectBadEnvelope(bitsToNumber("7ff0000000000000"));
  });

  it("sorts nested objects, preserves array order, and applies JSON.stringify rules", () => {
    expect(
      canonicalJson([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ]),
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(new Date("2026-09-08T02:15:30.123Z"))).toBe('"2026-09-08T02:15:30.123Z"');
    const holey = new Array(2);
    holey[1] = 1;
    expect(canonicalJson(holey)).toBe("[null,1]");
    expect(canonicalJson({ a: { toJSON: () => undefined }, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([{ toJSON: () => undefined }])).toBe("[null]");
    expect(canonicalJson(new Number(1))).toBe("1");
    expect(canonicalJson(new String("x"))).toBe('"x"');
    expect(canonicalJson(new Boolean(false))).toBe("false");
  });

  it("wraps throwing getters and toJSON as HORS_BAD_ENVELOPE without echoing the cause", () => {
    const getterBoom = new Error("boom");
    try {
      canonicalJson({
        get a() {
          throw getterBoom;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
      expect((error as HorsError).message).toBe("arguments are not JSON: serialisation failed");
      expect((error as HorsError).message).not.toContain("boom");
      expect((error as HorsError).cause).toBe(getterBoom);
    }

    const typeError = new TypeError("x");
    try {
      canonicalJson({
        toJSON() {
          throw typeError;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
      expect((error as HorsError).message).toBe("arguments are not JSON: serialisation failed");
      expect((error as HorsError).cause).toBe(typeError);
    }
  });

  it("rejects non-JSON values with HORS_BAD_ENVELOPE", () => {
    expectBadEnvelope(-Infinity);
    expectBadEnvelope(10n);
    expectBadEnvelope(() => 1);
    expectBadEnvelope(Symbol("x"));
    expectBadEnvelope("\ud800");
    expectBadEnvelope({ "\ud800": 1 });
    expectBadEnvelope(undefined);
  });

  it("canonicalises 512-deep arrays and rejects 513-deep arrays and objects", () => {
    const depth512 = JSON.parse("[".repeat(512) + "]".repeat(512));
    expect(canonicalJson(depth512)).toBe("[".repeat(512) + "]".repeat(512));

    const depth513 = JSON.parse("[".repeat(513) + "]".repeat(513));
    try {
      canonicalJson(depth513);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
      expect((error as HorsError).message).toContain("nesting");
    }

    let nestedObject: unknown = null;
    for (let i = 0; i < 513; i += 1) {
      nestedObject = { a: nestedObject };
    }
    try {
      canonicalJson(nestedObject);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
      expect((error as HorsError).message).toContain("nesting");
    }
  });

  it("turns a 100000-deep nested array into HORS_BAD_ENVELOPE rather than RangeError", () => {
    let nested: unknown = [];
    for (let i = 0; i < 100_000; i += 1) {
      nested = [nested];
    }
    try {
      canonicalJson(nested);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HorsError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as HorsError).code).toBe("HORS_BAD_ENVELOPE");
      expect((error as HorsError).message).toContain("nesting");
    }
  });
});
