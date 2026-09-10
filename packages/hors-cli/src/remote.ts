import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isPlainObject } from "hors-sdk";
import { resolve } from "hors-sdk/resolvers";
import { VERSION } from "./version.js";

export interface RemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly policy: unknown;
}

export async function listRemote(
  service: string,
  options: {
    services?: Readonly<Record<string, string>>;
    rpc?: { ens?: string; signatures?: Record<string, string> };
    cache?: false | { home?: string };
    fetch?: typeof fetch;
  },
): Promise<RemoteTool[]> {
  const url = await resolve(service, options);
  return listTools(url, options.fetch);
}

export async function listTools(url: string, fetchImpl?: typeof fetch): Promise<RemoteTool[]> {
  const client = new Client({ name: "hors-cli", version: VERSION });
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    fetchImpl === undefined ? undefined : { fetch: fetchImpl },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    return listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      policy: tool._meta?.["hors/policy"] ?? null,
    }));
  } finally {
    try {
      await client.close();
    } catch {
      // per-call transport
    }
  }
}

export function summariseSchema(inputSchema: unknown): string {
  if (!isPlainObject(inputSchema) || !isPlainObject(inputSchema.properties)) {
    return "(none)";
  }
  const properties = inputSchema.properties as Record<string, unknown>;
  const keys = Object.keys(properties);
  if (keys.length === 0) {
    return "(none)";
  }
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  return keys
    .map((name) => {
      const schema = properties[name];
      const type = isPlainObject(schema) && typeof schema.type === "string" ? schema.type : "any";
      return `${name}${required.has(name) ? "" : "?"}: ${type}`;
    })
    .join(", ");
}

export function renderPolicy(policy: unknown): string {
  if (!isPlainObject(policy)) {
    return "(unpublished)";
  }
  const origin = Array.isArray(policy.origin)
    ? policy.origin.map(String).join(",")
    : String(policy.origin ?? "");
  const parts = [`origin=${origin}`];
  if (typeof policy.name === "string") {
    parts.push(`name=${policy.name}`);
  }
  parts.push(`custom=${policy.custom === true}`);
  if (typeof policy.describe === "string") {
    parts.push(`describe=${policy.describe}`);
  }
  return parts.join(" ");
}
