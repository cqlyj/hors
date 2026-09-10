export function initTemplate(name: string): string {
  return `import { defineConfig } from "hors-sdk";

// HORS gate configuration. Run \`npx -y hors-cli connect --profile ${name}\`
// once in a terminal to create this service's wallet and pin its owner.
export default defineConfig({
  profile: "${name}",
  // owner: "auto",            // the humanId pinned by \`hors connect\` (default)
  // policy: "same-human",     // default; or "any-human", "public", or a definePolicy(...)
  // functions: {},            // per-function policies by name
  // rpc: { worldchain: "https://…" },  // set a dedicated World Chain RPC in production
});
`;
}

export function deriveProfileName(raw: string): string {
  let name = raw.replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9._-]/g, "-");
  if (name.startsWith(".") || name.startsWith("-") || name.startsWith("_")) {
    name = `p${name.slice(1)}`;
  }
  if (name.length > 64) {
    name = name.slice(0, 64);
  }
  return name === "" ? "default" : name;
}
