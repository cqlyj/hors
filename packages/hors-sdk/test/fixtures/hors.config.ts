import type { HorsConfig } from "../../src/config/schema.js";

const config: HorsConfig = {
  owner: "auto",
  policy: "public",
  functions: { approveTravelExpense: { origin: "any-human", rule: () => true } },
  dev: { mockOrigin: false },
};

export default config;
