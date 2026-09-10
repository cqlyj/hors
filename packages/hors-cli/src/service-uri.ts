import { classifyService } from "hors-sdk/resolvers";
import { UsageError } from "./io.js";

const NAME = /^[^\s]{1,64}$/;

export function assertServiceName(name: string): void {
  if (!NAME.test(name) || classifyService(name) !== undefined || name.includes("://")) {
    throw new UsageError("invalid services name");
  }
}

export function assertServiceUri(uri: string): void {
  if (classifyService(uri) === undefined) {
    throw new UsageError("invalid services URI");
  }
}
