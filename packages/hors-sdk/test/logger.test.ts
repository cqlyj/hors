import { describe, expect, it } from "vitest";
import type { LogLevelName } from "../src/config/env.js";
import { createLogger } from "../src/gate/logger.js";
import type { HorsContext, LogLevel } from "../src/policy/types.js";

const LEVELS: LogLevelName[] = ["silent", "error", "info", "debug"];
const EVENTS: LogLevel[] = ["error", "info", "debug"];

function kept(level: LogLevelName, event: LogLevel): number {
  if (level === "silent") {
    return 0;
  }
  if (level === "error") {
    return event === "error" ? 1 : 0;
  }
  if (level === "info") {
    return event === "debug" ? 0 : 1;
  }
  return 1;
}

describe("createLogger", () => {
  it.each(LEVELS.flatMap((level) => EVENTS.map((event) => [level, event] as const)))(
    "level %s keeps %s",
    (level, event) => {
      const lines: string[] = [];
      const log = createLogger(level, (line) => lines.push(line));
      log(event, "m");
      expect(lines).toHaveLength(kept(level, event));
    },
  );

  it("emits one JSON line with t, level, msg and optional data", () => {
    const lines: string[] = [];
    const log = createLogger(
      "debug",
      (line) => lines.push(line),
      () => Date.parse("2026-09-08T02:15:30.123Z"),
    );
    log("info", "hello", { a: 1 });
    expect(lines[0]).toBe(
      '{"t":"2026-09-08T02:15:30.123Z","level":"info","msg":"hello","data":{"a":1}}',
    );
    log("error", "x");
    expect(Object.keys(JSON.parse(lines[1] ?? "{}"))).toEqual(["t", "level", "msg"]);
  });

  it("is assignable to HorsContext.log", () => {
    const l: HorsContext["log"] = createLogger("debug", () => undefined);
    void l;
  });

  it("drops an unknown level under silent and under error", () => {
    for (const level of ["silent", "error"] as const) {
      const lines: string[] = [];
      const log = createLogger(level, (line) => lines.push(line));
      log("warn" as never, "x");
      expect(lines).toHaveLength(0);
    }
  });
});
