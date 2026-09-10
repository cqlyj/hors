import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { getEnsText, normalize } from "viem/ens";
import { echo, HorsError } from "../errors.js";
import { httpUrlWithoutCredentials } from "../url.js";
import type { ResolveOptions } from "./types.js";

const ENS_KEY = "agent-endpoint[mcp]";

export const ensRuntime = {
  async text(name: string, options?: ResolveOptions): Promise<string | null> {
    const client = createPublicClient({
      chain: mainnet,
      transport: http(options?.rpc?.ens),
    });
    return getEnsText(client, { name: normalize(name), key: ENS_KEY });
  },
};

export async function ens(name: string, options?: ResolveOptions): Promise<string> {
  let value: string | null;
  try {
    value = await ensRuntime.text(name, options);
  } catch (error) {
    throw new HorsError("RESOLVER_FAILED", `ENS lookup failed for ${echo(name)}`, undefined, {
      cause: error,
    });
  }
  if (value === null || value === "") {
    throw new HorsError("RESOLVER_FAILED", `no agent-endpoint[mcp] record for ${echo(name)}`);
  }
  const parsed = httpUrlWithoutCredentials(value);
  if (parsed === undefined || parsed.protocol !== "https:") {
    throw new HorsError("RESOLVER_FAILED", "ENS record is not an https URL");
  }
  return value;
}
