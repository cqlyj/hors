export interface ResolveCache {
  readonly [uri: string]: { readonly url: string; readonly at: number };
}

export interface ResolveOptions {
  readonly services?: Record<string, string>;
  readonly rpc?: { ens?: string; signatures?: Record<string, string> };
  readonly fetch?: typeof fetch;
  readonly cache?: false | { home?: string };
  readonly refresh?: boolean;
  readonly ipfsGateway?: string;
}

export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
