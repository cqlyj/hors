---
name: use-hors
description: Operate HORS-protected services through the hors_* bridge tools or the hors CLI, and preserve the human boundary for World App registration and challenges.
---

# Use HORS

HORS gates calls by the anonymous human behind an agent. You talk to gated
services through `hors mcp` tools or `npx -y hors-cli`. Never read or print the
key file under `~/.hors/<profile>/key`. When the user names `--home` or
`HORS_HOME`, pass that value to **every** command and never touch `~/.hors`.
`list` and `call` work without a pinned identity in mock mode (`HORS_MOCK=1`).

## When to use which tool

- `hors_status` / `npx -y hors-cli status` — is this profile connected? If
  `connected` is false or the CLI says `not connected`, tell the human to run
  `hors connect` in a visible terminal and never run it yourself. Follow `hint`.
- `hors_list` / `npx -y hors-cli list <service>` — unsigned `tools/list`. Run
  this before `hors_call` for an unfamiliar function. `<service>` is an
  address-book name, URL, resolver URI, or bare ENS name (`name.eth`).
- `hors_call` / `npx -y hors-cli call <service> <fn> [json]` — signed call.
  Send the JSON object exactly; do not invent keys. Attach `--meta` / `meta`
  only when the user asked for `hors/meta`.
- `hors_services` / `hors services` — local address book. Add with
  `hors_add_service` or `hors services add <name> <uri>`.
- `hors whoami` — print the pinned `humanId` for pasting into another
  service's `owner`.
- `hors doctor` — local diagnostics. `hors init` writes `hors.config.ts` only.

## Human boundary

Never run `hors connect` (or `hors connect --no-register`) for the human. Ask
them to run `npx -y hors-cli connect --profile <name>` in a visible terminal
and scan the World App QR. Wait until they confirm, then re-check
`hors_status`. The bridge must not perform registration.

## Denials and challenges

A result `{ denied: true, code, reason, challenge }` (CLI: `denied <code>:`
and exit 3) is final unless `challenge` is present. A challenge is data for
the human; do not retry blindly, do not satisfy it yourself, and do not
re-call until the human says they completed it.

`hors disconnect` deletes the profile and key. Require explicit confirmation.
