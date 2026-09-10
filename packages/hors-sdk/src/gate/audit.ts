import { thrownMessage } from "../errors.js";
import type { Address, HumanId } from "../identity.js";
import type { Logger } from "./logger.js";

export interface AuditEvent {
  readonly v: 1;
  readonly at: number;
  readonly fn: string;
  readonly callId: string;
  readonly transport: string;
  readonly local: boolean;
  readonly callerAddress: Address | null;
  readonly callerHumanId: HumanId | null;
  readonly status: "ok" | "deny";
  readonly code?: string;
  readonly policy?: string;
  readonly durationMs: number;
}

export type AuditListener = (event: AuditEvent) => void;

export function createAuditEmitter(log: Logger): {
  emit(event: AuditEvent): void;
  on(listener: AuditListener): () => void;
} {
  const listeners = new Set<AuditListener>();
  return {
    emit(event) {
      Object.freeze(event);
      log(event.status === "ok" ? "debug" : "info", "hors audit", { ...event });
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          log("error", "audit listener threw", { message: thrownMessage(error) });
        }
      }
    },
    on(listener) {
      listeners.add(listener);
      // WHY: without this flag, off() from a stale handle after the same function
      // was re-registered would delete the live registration.
      let open = true;
      return () => {
        if (!open) {
          return;
        }
        open = false;
        listeners.delete(listener);
      };
    },
  };
}
