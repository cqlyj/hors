import { McpServer } from "@modelcontextprotocol/server";
import { HorsError } from "hors-sdk";
import {
  type GateConfig,
  loadConfig,
  readAddressBook,
  readKeyFile,
  readProfile,
  writeAddressBook,
} from "hors-sdk/node";
import { type AgentBook, MockAgentBook } from "hors-sdk/world";
import { callerOptions, cliSigner } from "../profile.js";
import { listRemote } from "../remote.js";
import { assertServiceName, assertServiceUri } from "../service-uri.js";
import { thrownMessage } from "../util.js";
import { VERSION } from "../version.js";
import { lookupLive } from "../world.js";
import { addServiceSchema, callSchema, DESCRIPTIONS, emptySchema, listSchema } from "./schemas.js";

export interface BridgeDeps {
  readonly home: string;
  readonly profile: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
  readonly agentBook?: AgentBook;
  readonly log: (line: string) => void;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(code: string, message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
  };
}

function failOf(error: unknown) {
  return error instanceof HorsError
    ? toolError(error.code, error.message)
    : toolError("HORS_UNAVAILABLE", thrownMessage(error));
}

function connectHint(profile: string): string {
  return `Run npx -y hors-cli connect --profile ${profile} in a visible terminal and scan the World App QR.`;
}

export function createBridge(deps: BridgeDeps): McpServer {
  const server = new McpServer({ name: "hors", version: VERSION });
  const io = { agentBook: deps.agentBook, env: deps.env } as const;
  const loadedConfig = (async (): Promise<GateConfig | undefined> => {
    try {
      const result = await loadConfig({
        cwd: deps.cwd ?? process.cwd(),
        env: { ...deps.env, HORS_HOME: deps.home },
      });
      return result.config;
    } catch (error) {
      deps.log(`warning: config invalid (${thrownMessage(error)})`);
      return undefined;
    }
  })();

  const run = async (
    tool: string,
    work: () => Promise<{ result: ToolResult; kind: "ok" | "denied" | "error" }>,
  ): Promise<ToolResult> => {
    try {
      const { result, kind } = await work();
      deps.log(`hors mcp: ${tool} ${kind}`);
      return result;
    } catch (error) {
      deps.log(`hors mcp: ${tool} error`);
      return failOf(error);
    }
  };

  server.registerTool(
    "hors_status",
    { description: DESCRIPTIONS.hors_status, inputSchema: emptySchema },
    async () =>
      run("hors_status", async () => {
        const config = await loadedConfig;
        const record = await readProfile(deps.home, deps.profile);
        let keyOk = false;
        let keyHint: string | undefined;
        try {
          await readKeyFile(deps.home, deps.profile);
          keyOk = true;
        } catch (error) {
          if (error instanceof HorsError && error.code === "CONFIG_INVALID") {
            keyHint = error.message;
          }
        }
        const pin = record?.humanId;
        const mock = config?.mock === true;
        let live: string | null | undefined;
        let rpcError: string | undefined;
        if (record !== undefined && keyOk && !mock) {
          const looked = await lookupLive(io, record.address, config?.rpc.worldchain);
          live = looked.live;
          rpcError = looked.error;
        }
        let connected = false;
        let hint: string | null = connectHint(deps.profile);
        let humanId: string | null = pin ?? null;
        if (mock && record !== undefined && keyOk) {
          humanId = MockAgentBook.humanIdOf(record.address);
          connected = true;
          hint = null;
        } else if (!keyOk) {
          hint = keyHint ?? hint;
        } else if (pin === undefined) {
          connected = false;
        } else if (rpcError !== undefined) {
          connected = true;
          hint = `World Chain RPC unavailable (${rpcError}); signed calls may be denied with HORS_UNAVAILABLE`;
        } else if (live !== pin) {
          connected = false;
          hint = `The on-chain registration of ${record?.address} no longer matches the pinned humanId. Run npx -y hors-cli connect --profile ${deps.profile} in a visible terminal to re-register.`;
        } else {
          connected = true;
          hint = null;
        }
        return {
          kind: "ok",
          result: jsonResult({
            connected,
            address: record?.address ?? null,
            humanId,
            profile: deps.profile,
            hint,
            ...(mock ? { mock: true } : {}),
          }),
        };
      }),
  );

  server.registerTool(
    "hors_services",
    { description: DESCRIPTIONS.hors_services, inputSchema: emptySchema },
    async () =>
      run("hors_services", async () => {
        const book = await readAddressBook(deps.home);
        const rows = Object.keys(book)
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ name, uri: book[name] }));
        return { kind: "ok", result: jsonResult(rows) };
      }),
  );

  server.registerTool(
    "hors_add_service",
    { description: DESCRIPTIONS.hors_add_service, inputSchema: addServiceSchema },
    async ({ name, uri }) =>
      run("hors_add_service", async () => {
        try {
          assertServiceName(name);
          assertServiceUri(uri);
        } catch (error) {
          return { kind: "error", result: toolError("USAGE", thrownMessage(error)) };
        }
        const book = await readAddressBook(deps.home);
        await writeAddressBook(deps.home, { ...book, [name]: uri });
        return { kind: "ok", result: jsonResult({ name, uri }) };
      }),
  );

  server.registerTool(
    "hors_list",
    { description: DESCRIPTIONS.hors_list, inputSchema: listSchema },
    async ({ service }) =>
      run("hors_list", async () => {
        const config = await loadedConfig;
        const tools = await listRemote(service, callerOptions(deps.home, config, deps.fetch));
        return { kind: "ok", result: jsonResult(tools) };
      }),
  );

  server.registerTool(
    "hors_call",
    { description: DESCRIPTIONS.hors_call, inputSchema: callSchema },
    async ({ service, fn, args, meta }) =>
      run("hors_call", async () => {
        try {
          await readKeyFile(deps.home, deps.profile);
        } catch (error) {
          if (error instanceof HorsError && error.code === "PROFILE_NOT_FOUND") {
            return {
              kind: "error",
              result: toolError("PROFILE_NOT_FOUND", connectHint(deps.profile)),
            };
          }
          throw error;
        }
        const config = await loadedConfig;
        const signer = await cliSigner(deps.home, deps.profile, config, deps.fetch);
        const outcome = await signer.call(
          service,
          fn,
          args,
          meta === undefined ? undefined : { meta },
        );
        if (!outcome.ok) {
          const denied = {
            denied: true,
            code: outcome.code,
            reason: outcome.reason,
            challenge: outcome.challenge,
          };
          return { kind: "denied", result: jsonResult(denied) };
        }
        return {
          kind: "ok",
          result: {
            content: outcome.result.content as ToolResult["content"],
            ...(outcome.hors === null ? {} : { _meta: { "hors/result": outcome.hors } }),
          },
        };
      }),
  );

  return server;
}
