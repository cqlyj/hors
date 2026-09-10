# hors-cli

Command line (`hors`) and MCP bridge for HORS-gated services: create an agent identity
with World App, inspect and call gated services, and let any MCP host call them as your
human. Always invoke as `npx -y hors-cli`, never `npx hors`.

```sh
npx -y hors-cli connect --profile me                   # wallet + World App QR, once
npx -y hors-cli list https://svc.example/mcp           # tools and policies, unsigned
npx -y hors-cli call https://svc.example/mcp approve '{"amount":1}'
```

Bridge an MCP host:

```sh
codex mcp add hors -- npx -y hors-cli mcp --profile codex
npx -y hors-cli connect --profile codex
```

The host gains `hors_status`, `hors_services`, `hors_add_service`, `hors_list` and
`hors_call`. Denials are returned as results with a code, a reason and an optional
challenge; the bridge never registers, never prints keys and never satisfies a challenge
itself. The `skills/use-hors/SKILL.md` file in this package teaches an agent those rules.

Service authors: `npx -y hors-cli init` writes `hors.config.ts`, then `connect` pins the
owner. Exit codes: 0 ok, 1 error, 2 usage, 3 denied, 4 not connected. Node ≥ 22.18.

Documentation: [CLI and MCP bridge](https://github.com/cqlyj/hors/blob/main/docs/cli.md) ·
[SDK reference](https://github.com/cqlyj/hors/blob/main/docs/sdk.md) ·
[repository](https://github.com/cqlyj/hors)
