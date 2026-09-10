import { createPublicClient, custom, encodeAbiParameters, type PublicClient } from "viem";
import { worldchain } from "viem/chains";
import { AGENTBOOK_ADDRESS } from "../../src/world/agentbook.js";

export interface FakeCall {
  readonly fn: "lookupHuman" | "getNextNonce";
  readonly address: string;
  readonly data: string;
}

export function fakeWorldChain(
  opts: { humans?: Record<string, bigint>; nonces?: Record<string, bigint> } = {},
): { client: PublicClient; calls: FakeCall[]; fail: { current: boolean } } {
  const calls: FakeCall[] = [];
  const fail = { current: false };
  const humans = new Map(
    Object.entries(opts.humans ?? {}).map(([address, value]) => [address.toLowerCase(), value]),
  );
  const nonces = new Map(
    Object.entries(opts.nonces ?? {}).map(([address, value]) => [address.toLowerCase(), value]),
  );

  const client = createPublicClient({
    chain: worldchain,
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (method !== "eth_call") {
            throw new Error(`unexpected method ${method}`);
          }
          const { to, data } = (params as [{ to: string; data: string }])[0] ?? {
            to: "",
            data: "",
          };
          if (to.toLowerCase() !== AGENTBOOK_ADDRESS.toLowerCase()) {
            throw new Error("unexpected AgentBook address");
          }
          const selector = data.slice(0, 10).toLowerCase();
          const address = `0x${data.slice(-40).toLowerCase()}`;
          const fn =
            selector === "0x451a02f4"
              ? "lookupHuman"
              : selector === "0x90193b7c"
                ? "getNextNonce"
                : undefined;
          if (fn === undefined) {
            throw new Error("unknown selector");
          }
          calls.push({ fn, address, data });
          if (fail.current) {
            throw new Error("rpc down");
          }
          const value =
            fn === "lookupHuman" ? (humans.get(address) ?? 0n) : (nonces.get(address) ?? 0n);
          return encodeAbiParameters([{ type: "uint256" }], [value]);
        },
      },
      { retryCount: 0 },
    ),
  });

  return { client: client as PublicClient, calls, fail };
}
