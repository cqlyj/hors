import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/gate/audit.js";
import { createAuditEmitter } from "../src/gate/audit.js";
import { warnOwnerUnresolved } from "../src/gate/owner.js";
import { ADDR_A, HUMAN_A } from "./helpers/context.js";
import { memoryLogger } from "./helpers/logger.js";

const EVENT: AuditEvent = {
  v: 1,
  at: 1,
  fn: "f",
  callId: "c",
  transport: "wrap",
  local: false,
  callerAddress: ADDR_A,
  callerHumanId: HUMAN_A,
  status: "ok",
  durationMs: 0,
};

describe("createAuditEmitter and warnOwnerUnresolved", () => {
  it("calls listeners in order, once, and ignores adds during emit (A2)", () => {
    const { log, events } = memoryLogger();
    const { emit, on } = createAuditEmitter(log);
    const seen: string[] = [];
    const a = (event: AuditEvent) => {
      seen.push("a");
      on(() => {
        seen.push("late");
      });
      expect(event).toBe(EVENT);
    };
    const b = () => {
      seen.push("b");
    };
    const off = on(a);
    on(a);
    on(b);
    emit(EVENT);
    expect(seen).toEqual(["a", "b"]);
    off();
    off();
    seen.length = 0;
    emit({ ...EVENT, status: "deny" });
    expect(seen).toContain("b");
    expect(seen).not.toContain("a");
    expect(events.filter((event) => event.message === "hors audit")).toEqual([
      expect.objectContaining({ level: "debug", message: "hors audit" }),
      expect.objectContaining({ level: "info", message: "hors audit" }),
    ]);
  });

  it("freezes the event so a listener cannot mutate what later listeners see", () => {
    const { log } = memoryLogger();
    const { emit, on } = createAuditEmitter(log);
    const seen: Array<AuditEvent["status"]> = [];
    on((event) => {
      expect(() => {
        (event as { status: string }).status = "deny";
      }).toThrow();
      seen.push(event.status);
    });
    on((event) => {
      seen.push(event.status);
    });
    emit({ ...EVENT });
    expect(seen).toEqual(["ok", "ok"]);
  });

  it("logs a throwing listener and still runs the next one", () => {
    const { log, events } = memoryLogger();
    const { emit, on } = createAuditEmitter(log);
    on(() => {
      throw new Error("boom");
    });
    let ran = false;
    on(() => {
      ran = true;
    });
    emit(EVENT);
    expect(ran).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "audit listener threw",
        data: { message: "boom" },
      }),
    );
  });

  it("emits the unresolved-owner warning with the N4 fields (A3)", () => {
    const { log, events } = memoryLogger();
    warnOwnerUnresolved(log, { home: "/h", name: "svc" });
    expect(events).toEqual([
      expect.objectContaining({
        level: "error",
        message:
          "HORS owner unresolved: remote same-human calls are denied until the profile is connected",
        data: expect.objectContaining({
          fix: "hors connect --profile svc",
          alternative: "set HORS_OWNER to the value of hors whoami",
          profile: expect.stringMatching(/svc[/\\]profile\.json$/),
        }),
      }),
    ]);
  });
});
