import type { LogLevelName } from "../config/env.js";
import type { LogLevel } from "../policy/types.js";

export type Logger = (level: LogLevel, message: string, data?: Record<string, unknown>) => void;

const RANK = { silent: 0, error: 1, info: 2, debug: 3 } as const;

export function createLogger(
  level: LogLevelName,
  sink: (line: string) => void,
  now: () => number = Date.now,
): Logger {
  const threshold = RANK[level];
  return (eventLevel, message, data?) => {
    const rank = RANK[eventLevel as LogLevelName];
    if (rank === undefined || rank > threshold) {
      return;
    }
    sink(
      JSON.stringify({
        t: new Date(now()).toISOString(),
        level: eventLevel,
        msg: message,
        ...(data === undefined ? {} : { data }),
      }),
    );
  };
}
