# hors-cli

`hors-cli` is the command line and MCP bridge for HORS-gated services. Humans use it to
create an agent wallet and register it with World App (`connect`), to inspect a service's
tools and policies (`list`), and to make signed calls (`call`). MCP hosts — Codex, Claude
Code, Cursor, anything that launches stdio servers — run `hors mcp` to get the same
capabilities as tools. The gate side (protecting your own service) is in [sdk.md](sdk.md).

## Install and invoke

```sh
npx -y hors-cli <command>        # no install
npm i -g hors-cli && hors <command>
```

Always write `npx -y hors-cli`, never `npx hors`: an unrelated `hors` package exists on
npm and `npx hors` fails with "could not determine executable to run". Node ≥ 22.18.

## Profiles

A **profile** is one agent wallet: a directory under `HORS_HOME` (default `~/.hors`).

```
~/.hors/
  <profile>/key            0600, the private key; never printed, never logged
  <profile>/profile.json   { address, humanId?, registeredAt?, createdAt?, label? }
  services.json            the address book: name → URL or resolver URI
  cache/resolve.json       resolver results, one hour
```

`humanId` is the **pin**: the anonymous World identity confirmed on chain at `connect`
time. A profile with a key but no pin is created but not connected. Profile names match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; a service gets its own profile (`hors init` picks the
package name) so wallets are never shared between agents.

Every command takes `--profile <name>` (default `HORS_PROFILE`, else `default`) and
`--home <dir>` (overrides `HORS_HOME` for that command only). In tests and scratch setups
always pass `--home`; never point tooling at the real `~/.hors`.

## Commands

### `hors init [--profile <name>] [--force]`

Writes a starter `hors.config.ts` in the current directory with `profile` set to
`<name>` (default: the `package.json` name, else the directory name) and prints the next
step. Creates no keys, needs no terminal. Never overwrites without `--force`.

### `hors connect [--label <text>] [--no-register]`

Creates the profile if it does not exist (key + `profile.json`), then registers the
wallet with World ID: World's registration flow runs in your terminal, shows a QR code,
you scan it in World App, the CLI confirms the registration on chain and pins the
`humanId`. Idempotent — a connected profile is verified against the chain and offered
re-registration on mismatch. Requires a TTY unless `--no-register`, which only creates the
wallet (for mock-mode development). This is the one command an agent must never run for
you; it asks you to run it in a visible terminal instead.

### `hors status`

```
profile  work
address  0x…
humanId  0x…
live     0x…
config   /path/hors.config.ts
mock     off
```

`live` is the current on-chain registration of the address. `live ≠ humanId` means
someone re-registered the wallet: the CLI prints a hijack warning naming `hors connect`
as the fix and exits 1. Not connected → exit 4. RPC unreachable → `live unavailable (<reason>)`,
exit 1. `--json`: `{ profile, address, humanId, live, connected, hijacked, config, mock }`.

### `hors whoami`

Prints the pinned `humanId` alone, for pasting into another service's `owner`. Exit 4
when not connected.

### `hors doctor`

Local diagnostics, one line per check (`ok` / `warn` / `fail`): `config` (file found and
valid), `rpc` (World Chain reachable, block number), `clock` (skew against block time),
`profile` / `identity`, `key` (file mode must be `0600`), `registration` (live matches the
pin), `owner`. Warns when the public default RPC is in use and when `HORS_PRIVATE_KEY` is
set without `HORS_OWNER` or a pin. Exit 1 if any check failed.

### `hors services [add <name> <uri> | rm <name>]`

Shows or edits `<HORS_HOME>/services.json`. A `uri` is an `http(s)://` URL without
credentials, `ens:<name>`, a bare `<name>.eth`, or `erc8004:eip155:<chain>/<id>`. Entries under `services` in a
`hors.config.*` take precedence over the file.

### `hors list <service>`

Resolves the service, connects, and prints every tool with its description, argument
summary and published policy — no signature needed, exactly like a CORS preflight.

```
approve
  amount exceeds limit → challenge
  args: amount: number
  policy: same-human
```

`<service>` is an address-book name, a URL, a resolver URI, or any bare ENS name.
`--json` prints one `{ name, description, inputSchema, policy }` per line.

### `hors call <service> <fn> [json] [--meta <json>]`

Signs and calls. `[json]` is the arguments object, sent exactly as given. `--meta`
attaches unsigned `hors/meta` (for challenge responses). Output is the tool's text
content, or a denial:

```
denied HORS_ORIGIN_MISMATCH: caller does not match the function's origin
challenge: {"type":"approval","limit":100}
```

Exit 3 on denial (`--json`: `{ ok: false, code, reason, challenge }`); success is
`{ ok: true, result, hors }` under `--json`. A service that never answers fails after the
MCP client's 60 s request timeout with `HORS_UNAVAILABLE`.

### `hors mcp`

Runs the [MCP bridge](#the-mcp-bridge) on stdio for the selected profile.

### `hors disconnect [--yes]`

Deletes the profile directory, key included, after printing the address and asking for
confirmation (`--yes` skips the prompt; without a TTY and without `--yes` it exits 2).

## Global flags, environment, exit codes

| Flag        | Effect                                                              |
| ----------- | ------------------------------------------------------------------- |
| `--profile` | Profile name; default `HORS_PROFILE`, else `default`.               |
| `--home`    | Profile directory for this command; default `HORS_HOME`, else `~/.hors`. |
| `--json`    | One JSON object per command (one per line for lists); no ANSI.      |
| `--quiet`   | Suppress informational lines; never results, denials or errors.     |

Caller-side commands (`list`, `call`, `mcp`, `status`, `doctor`) also read the nearest
`hors.config.*` in the **current directory** for `services`, `rpc.ens` and
`rpc.signatures` — run them in the service directory or from an empty one so a stray
config does not surprise you.

| Variable              | Effect                                                   |
| --------------------- | -------------------------------------------------------- |
| `HORS_HOME`           | Profile directory; default `~/.hors`.                    |
| `HORS_PROFILE`        | Default profile name.                                    |
| `HORS_CONFIG`         | Path to a config file instead of discovery.              |
| `HORS_WORLDCHAIN_RPC` | World Chain RPC for `status`/`doctor` lookups.           |
| `HORS_MOCK`           | `1`: report the mock identity (see Mock mode).           |
| `HORS_LOG`            | `silent` \| `error` \| `info` \| `debug`.                |

| Exit | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 0    | Success.                                                                                                  |
| 1    | Any other error: RPC or resolver failure, hijack warning, declined confirmation, failed `doctor` check.    |
| 2    | Usage: unknown command or option, invalid profile name, `[json]`/`--meta` not a JSON object, missing TTY. |
| 3    | Denied by policy (`call`); the denial is printed as the result.                                           |
| 4    | Not connected: no key, or no pinned `humanId` where one is required. The message names the fix.           |

Errors go to stderr as `error: <message>` (`--json`: `{ "error": { "code", "message" } }`
on stdout), never as stack traces. Human output strips terminal control characters, so a
malicious service cannot inject escape sequences through tool text or policy descriptions.

## The MCP bridge

`hors mcp` is a stdio MCP server that holds one profile's wallet and lets the host call
remote gated services. The host needs no wallet support of its own.

```sh
codex mcp add hors -- npx -y hors-cli mcp --profile codex
claude mcp add hors -- npx -y hors-cli mcp --profile claude
```

Cursor and other hosts with a JSON config:

```json
{ "mcpServers": { "hors": { "command": "npx", "args": ["-y", "hors-cli", "mcp", "--profile", "cursor"] } } }
```

Then connect that profile once, in a visible terminal: `npx -y hors-cli connect --profile codex`.
The bridge starts even when the profile is not connected; `hors_status` tells the agent
what you must do.

| Tool               | Input                           | Output                                                                                                      |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `hors_status`      | `{}`                            | `{ connected, address, humanId, profile, hint, mock? }`. `hint` is the exact command the human must run, or `null`. |
| `hors_services`    | `{}`                            | The address book: `[{ name, uri }]`.                                                                        |
| `hors_add_service` | `{ name, uri }`                 | Adds an entry; `uri` is a URL, `ens:`/`.eth` name or `erc8004:` URI.                                        |
| `hors_list`        | `{ service }`                   | `[{ name, description, inputSchema, policy }]` — unsigned.                                                  |
| `hors_call`        | `{ service, fn, args?, meta? }` | The remote result content, or `{ denied: true, code, reason, challenge }`.                                  |

Behaviour the host can rely on:

- `hors_call` signs exactly the `args` object it is given — the bridge never normalises or
  defaults fields. `args` is an object here, where the CLI takes a JSON string.
- A denial is a normal tool result (`isError: false`) so the model sees it; every other
  failure (unknown service, connection failure, profile not connected) is a tool error
  `<code>: <message>`.
- The bridge never performs registration, never prints the key, and never tries to satisfy
  a challenge; challenges are returned so the agent and its human can act.
- `connected` is true when the profile has a key, a pin, and the live registration equals
  the pin; when the RPC is down the pin decides and `hint` says so; when the live value
  differs, `connected` is false and `hint` names the re-registration command.
- Sandboxed hosts must allow local network access for calls to `127.0.0.1` services.

### The `use-hors` skill

The package ships `skills/use-hors/SKILL.md` (after install:
`node_modules/hors-cli/skills/use-hors/SKILL.md`), an agent skill that teaches a host the
human boundary: run `hors_list` before an unfamiliar `hors_call`, treat a denial as final
unless a challenge is present, never run `hors connect` for the human, pass `--home` to
every command when the user named one. Copy it into your host's skill directory
(for Codex, `~/.codex/skills/use-hors/SKILL.md`).

## Mock mode (developing without World App)

Put `HORS_MOCK=1` on the **service** you are developing: its gate replaces AgentBook with
a deterministic mock in which every wallet is its own fake human. Then:

```sh
npx -y hors-cli connect --profile svc   --no-register --home /tmp/h   # the service's wallet
npx -y hors-cli connect --profile other --no-register --home /tmp/h   # another "human"
HORS_MOCK=1 HORS_HOME=/tmp/h HORS_PROFILE=svc node server.mjs
npx -y hors-cli call http://127.0.0.1:8787/mcp approve '{"amount":1}' --profile svc   --home /tmp/h   # same-human passes
npx -y hors-cli call http://127.0.0.1:8787/mcp approve '{"amount":1}' --profile other --home /tmp/h   # HORS_ORIGIN_MISMATCH
```

Signatures are real; only the registry is mocked, and a gate refuses mock mode under
`NODE_ENV=production`. With `HORS_MOCK=1` on the CLI as well, `whoami` and `status`
print the mock identity (marked `(mock)`, `"mock": true`) — the value a mock gate compares
against — and skip the chain lookup.

## Troubleshooting

| Symptom                                                           | Cause and fix                                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `not connected: run npx -y hors-cli connect …` (exit 4)           | No key or no pin for this profile. Run the printed command in a visible terminal.                                    |
| `warning: on-chain registration … no longer matches the pinned humanId` | Someone re-registered the wallet. Run `hors connect` to re-register; the gate keeps using the pin meanwhile.     |
| `denied HORS_ORIGIN_MISMATCH` (exit 3)                            | Your human is not the service's owner (or not in its origin list). Not an error; check `hors list` for the policy.   |
| `denied HORS_DOMAIN_MISMATCH`                                     | You called a URL the service does not consider itself to be (proxy rewrote `Host`). The service sets `origins`.      |
| `denied HORS_NOT_HUMAN`                                           | The calling wallet is not registered. `hors connect` without `--no-register`.                                        |
| `HORS_UNAVAILABLE` (exit 1)                                       | The service, its RPC, or the network is unreachable — including a silent server after 60 s.                          |
| `RESOLVER_FAILED: unknown service`                                | Not in the address book of this `--home`; use the URL or `hors services add`.                                        |
| `status`/`doctor` show a dead RPC you did not configure           | A `hors.config.*` in the current directory is being read. Run from the service directory or an empty one.            |
| `npx hors` fails                                                  | Wrong package. Use `npx -y hors-cli`.                                                                                |
