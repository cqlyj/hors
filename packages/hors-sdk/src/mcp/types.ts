import type {
  Icon,
  McpServer,
  RegisteredTool,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import type { CreateGateOptions, Gate } from "../gate/gate.js";
import type { HorsContext, Policy } from "../policy/types.js";

export interface HorsMcpOptions extends CreateGateOptions {
  readonly gate?: Gate; // prebuilt; excludes every other key except transport
  /** Overrides call detection. `"http"` without an HTTP request needs `origins` — there is no URL to derive. */
  readonly transport?: "stdio" | "http";
}

// Mirrors the SDK's registerTool config field list. A new SDK field is invisible
// to deployers using hors until this type is updated.
export interface HorsToolConfig<
  InputArgs extends StandardSchemaWithJSON | undefined,
  OutputArgs extends StandardSchemaWithJSON | undefined,
> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
  hors?: Policy; // inline policy; absent → functions[name] ?? default
}

type HorsServerContext = ServerContext & { hors: HorsContext };

// Dispatch on the schema, not function assignability: a 2-arg callback is
// assignable to a 1-arg type in TypeScript, so WithHors<F> cannot tell them apart.
type HorsToolCallback<InputArgs extends StandardSchemaWithJSON | undefined> =
  InputArgs extends StandardSchemaWithJSON
    ? ToolCallback<InputArgs> extends (args: infer A, ctx: ServerContext) => infer R
      ? (args: A, ctx: HorsServerContext) => R
      : never
    : (ctx: HorsServerContext) => ReturnType<ToolCallback<undefined>>;

export type HorsRegisterTool = <
  OutputArgs extends StandardSchemaWithJSON | undefined = undefined,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined,
>(
  name: string,
  config: HorsToolConfig<InputArgs, OutputArgs>,
  cb: HorsToolCallback<InputArgs>,
) => RegisteredTool;

/**
 * Same object as the original `McpServer`, but `registerTool` is the HORS
 * overload. Keep the original reference for `createMcpHandler` / `serveStdio`:
 * `const server = new McpServer(…); const gated = await hors(server); gated.registerTool(…); return server;`
 */
export type HorsMcpServer = Omit<McpServer, "registerTool"> & { registerTool: HorsRegisterTool };
