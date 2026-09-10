import type { Logger } from "../../src/gate/logger.js";
import type { LogLevel } from "../../src/policy/types.js";

export function memoryLogger(): {
  log: Logger;
  events: Array<{ level: LogLevel; message: string; data?: Record<string, unknown> }>;
} {
  const events: Array<{ level: LogLevel; message: string; data?: Record<string, unknown> }> = [];
  return {
    events,
    log: (level, message, data) => {
      events.push(data === undefined ? { level, message } : { level, message, data });
    },
  };
}
