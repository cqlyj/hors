# Changelog

## 0.1.0 (unreleased)

First release of both packages at the same version. The version field on disk stays
`0.0.0` until publish.

- **hors-sdk** — gate (`createGate`, `definePolicy`, `defineConfig`), MCP and HTTP
  adapters, `createSigner`, resolvers (`resolve`, `classifyService`, ENS, ERC-8004),
  World AgentBook client, and `hors-sdk/node` (profiles, key file, address book,
  `loadConfig`).
- **hors-cli** — the `hors` binary (`init`, `connect`, `status`, `whoami`, `services`,
  `list`, `call`, `mcp`, `doctor`, `disconnect`) and the stdio MCP bridge. Depends on
  `hors-sdk` at the exact released version; the `workspace:*` specifier in this
  repository is rewritten by pnpm on publish.
