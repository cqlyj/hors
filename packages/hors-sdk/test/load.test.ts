import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadConfigFile, mergeLayers, resolveConfig } from "../src/config/load.js";
import { defineConfig, validateConfig } from "../src/config/schema.js";
import { HorsError } from "../src/errors.js";
import { withTempDir } from "./helpers/tmp.js";

const fixtures = path.dirname(fileURLToPath(new URL("./fixtures/hors.config.ts", import.meta.url)));

function expectConfigInvalid(run: () => unknown, substring: string): HorsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("CONFIG_INVALID");
    expect((error as HorsError).message).toContain(substring);
    return error as HorsError;
  }
  expect.unreachable();
}

async function expectConfigInvalidAsync(
  run: () => Promise<unknown>,
  substring: string,
): Promise<HorsError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HorsError);
    expect((error as HorsError).code).toBe("CONFIG_INVALID");
    expect((error as HorsError).message).toContain(substring);
    return error as HorsError;
  }
  expect.unreachable();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfigFile, mergeLayers and resolveConfig", () => {
  it("uses a supplied env alone and ignores process.env", async () => {
    vi.stubEnv("HORS_MOCK", "1");
    const { config } = await loadConfig({ env: {}, configFile: false });
    expect(config.mock).toBe(false);
  });
  it("discovers hors.config.mjs before hors.config.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "hors.config.mjs"),
        'export default { owner: "auto", maxAgeMs: 1 };\n',
      );
      await writeFile(path.join(dir, "hors.config.json"), '{"owner":"auto","maxAgeMs":2}\n');
      const loaded = await loadConfigFile({ cwd: dir });
      expect(loaded?.path.endsWith("hors.config.mjs")).toBe(true);
      expect(loaded?.config).toEqual({ owner: "auto", maxAgeMs: 1 });
    });
  });

  it("loads a json file when it is the only match", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "hors.config.json"), '{"policy":"public"}\n');
      const loaded = await loadConfigFile({ cwd: dir });
      expect(loaded?.config).toEqual({ policy: "public" });
    });
  });

  it("returns undefined when the working directory has no config file", async () => {
    await withTempDir(async (dir) => {
      expect(await loadConfigFile({ cwd: dir })).toBeUndefined();
    });
  });

  it("loads the typescript fixture by absolute and relative path", async () => {
    const absolute = path.join(fixtures, "hors.config.ts");
    const loaded = await loadConfigFile({ path: absolute, cwd: "/tmp" });
    expect(loaded?.path.endsWith("hors.config.ts")).toBe(true);
    const config = loaded?.config as {
      policy: string;
      functions: { approveTravelExpense: { rule: unknown } };
    };
    expect(config.policy).toBe("public");
    expect(typeof config.functions.approveTravelExpense.rule).toBe("function");

    const relative = await loadConfigFile({
      path: "hors.config.ts",
      cwd: fixtures,
    });
    expect(relative?.config).toEqual(loaded?.config);
  });

  it("names the absolute path when an explicit file is missing", async () => {
    await withTempDir(async (dir) => {
      const missing = path.resolve(dir, "missing.config.ts");
      const error = await expectConfigInvalidAsync(
        () => loadConfigFile({ path: "missing.config.ts", cwd: dir }),
        "config file not found:",
      );
      expect(error.message).toContain(missing);
    });
  });

  it("reports invalid JSON without a cause", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "hors.config.json");
      await writeFile(file, "{ owner:");
      const error = await expectConfigInvalidAsync(
        () => loadConfigFile({ path: file, cwd: dir }),
        "config file is not valid JSON",
      );
      expect(error.cause).toBeUndefined();
    });
  });

  it("strips a leading BOM from JSON", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "hors.config.json");
      await writeFile(file, '\uFEFF{"policy":"public"}\n');
      const loaded = await loadConfigFile({ path: file, cwd: dir });
      expect(loaded?.config).toEqual({ policy: "public" });
    });
  });

  it("rejects an explicit path that is not a config extension without executing it", async () => {
    await withTempDir(async (dir) => {
      delete (globalThis as { __hors_ran?: boolean }).__hors_ran;
      for (const name of ["x.yaml", "hors.config"]) {
        const file = path.join(dir, name);
        await writeFile(file, "globalThis.__hors_ran = true;\n");
        const error = await expectConfigInvalidAsync(
          () => resolveConfig({ env: {}, cwd: dir, configFile: name }),
          "config file must end in .ts, .mts, .js, .mjs or .json:",
        );
        expect(error.message).toContain(path.resolve(dir, name));
        expect((globalThis as { __hors_ran?: boolean }).__hors_ran).toBeUndefined();
      }
    });
  });

  it("rethrows a HorsError thrown while the config module evaluates", async () => {
    await withTempDir(async (dir) => {
      const errorsHref = new URL("../src/errors.ts", import.meta.url).href;
      const file = path.join(dir, "dup.mjs");
      await writeFile(
        file,
        `import { HorsError } from ${JSON.stringify(errorsHref)};\nthrow new HorsError("CONFIG_INVALID", "policy dup is already defined");\n`,
      );
      const error = await expectConfigInvalidAsync(
        () => loadConfigFile({ path: file, cwd: dir }),
        "policy dup is already defined",
      );
      expect(error.message).toBe("policy dup is already defined");
    });
  });

  it("names a non-object default export", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "nope.mjs");
      await writeFile(file, 'export default "nope";\n');
      const error = await expectConfigInvalidAsync(
        () => loadConfigFile({ path: file, cwd: dir }),
        "config file default export must be a plain object:",
      );
      expect(error.message).toContain(file);
    });
  });

  it("reports a failed module load with a cause", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "hors.config.mjs");
      await writeFile(file, "export default {\n");
      const error = await expectConfigInvalidAsync(
        () => loadConfigFile({ path: file, cwd: dir }),
        "config file failed to load",
      );
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  it("requires a default export", async () => {
    await expectConfigInvalidAsync(
      () => loadConfigFile({ path: path.join(fixtures, "no-default.mjs"), cwd: fixtures }),
      "config file has no default export",
    );
  });

  it("merges layers with later keys winning and nested objects merging one level", () => {
    expect(mergeLayers([undefined, { a: 1 }])).toEqual({ a: 1 });
    expect(mergeLayers([{ owner: "a" }, { owner: "b" }])).toEqual({ owner: "b" });
    expect(mergeLayers([{ owner: "a" }, { owner: undefined }])).toEqual({ owner: "a" });
    expect(
      mergeLayers([
        { rpc: { worldchain: "f", signatures: { "eip155:1": "x" } } },
        { rpc: { worldchain: "e" } },
      ]),
    ).toEqual({ rpc: { worldchain: "e", signatures: { "eip155:1": "x" } } });
    expect(
      mergeLayers([{ functions: { a: "public" } }, { functions: { b: "any-human" } }]),
    ).toEqual({ functions: { a: "public", b: "any-human" } });
    expect(mergeLayers([{ deny: ["a"] }, { deny: ["b"] }])).toEqual({ deny: ["b"] });
    expect(mergeLayers([{ origins: ["https://a"] }, { origins: ["https://b"] }])).toEqual({
      origins: ["https://b"],
    });
    expect(mergeLayers([{ cache: { humanTtlMs: 1 } }, { cache: { nullTtlMs: 2 } }])).toEqual({
      cache: { humanTtlMs: 1, nullTtlMs: 2 },
    });
    expect(mergeLayers([{ dev: { mockOrigin: true } }, { dev: { mockOrigin: false } }])).toEqual({
      dev: { mockOrigin: false },
    });
    expect(mergeLayers([{ services: { a: "1" } }, { services: { b: "2" } }])).toEqual({
      services: { a: "1", b: "2" },
    });
    expect(
      mergeLayers([
        { rpc: { signatures: { "eip155:1": "a" } } },
        { rpc: { signatures: { "eip155:2": "b" } } },
      ]),
    ).toEqual({ rpc: { signatures: { "eip155:2": "b" } } });
  });

  it("defines an own __proto__ key instead of replacing the prototype", () => {
    const merged = mergeLayers([JSON.parse('{"__proto__":{"polluted":1},"owner":"auto"}')]);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expectConfigInvalid(
      () => validateConfig(merged, { nodeEnv: undefined }),
      "unknown config key __proto__",
    );

    const nested = mergeLayers([JSON.parse('{"rpc":{"__proto__":{"x":1}}}')]);
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expectConfigInvalid(
      () => validateConfig(nested, { nodeEnv: undefined }),
      "unknown config key rpc.__proto__",
    );
  });

  it("rejects a non-object layer and does not mutate inputs", () => {
    expectConfigInvalid(() => mergeLayers(["x"]), "config must be a plain object");
    expectConfigInvalid(() => mergeLayers([[]]), "config must be a plain object");
    expectConfigInvalid(() => mergeLayers([null]), "config must be a plain object");
    const first = { owner: "a", rpc: { worldchain: "f" } };
    const second = { rpc: { ens: "e" } };
    const snapshot = structuredClone({ first, second });
    const result = mergeLayers([first, second]);
    expect(first).toEqual(snapshot.first);
    expect(second).toEqual(snapshot.second);
    expect(result).not.toBe(first);
    expect(result).not.toBe(second);
    expect(result).toEqual({ owner: "a", rpc: { worldchain: "f", ens: "e" } });
  });

  it("resolves options over env over file over defaults", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "hors.config.mjs"),
        'export default { owner: "auto", maxAgeMs: 1000, rpc: { worldchain: "http://file", signatures: { "eip155:1": "http://one" } } };\n',
      );
      const resolved = await resolveConfig({
        options: { maxAgeMs: 2000 },
        env: { HORS_WORLDCHAIN_RPC: "http://env", HORS_LOG: "debug" },
        cwd: dir,
      });
      expect(resolved.config.maxAgeMs).toBe(2000);
      expect(resolved.config.rpc.worldchain).toBe("http://env");
      expect(resolved.config.rpc.signatures["eip155:1"]).toBe("http://one");
      expect(resolved.path?.endsWith("hors.config.mjs")).toBe(true);
      expect(resolved.logLevel).toBe("debug");

      const skipped = await resolveConfig({
        env: { HORS_WORLDCHAIN_RPC: "http://env", HORS_LOG: "debug" },
        cwd: dir,
        configFile: false,
      });
      expect(skipped.path).toBeUndefined();
      expect(skipped.config.maxAgeMs).toBe(300_000);
    });
  });

  it("loads HORS_CONFIG from an empty cwd and lets configFile win", async () => {
    await withTempDir(async (empty) => {
      const ts = path.join(fixtures, "hors.config.ts");
      const fromEnv = await resolveConfig({
        env: { HORS_CONFIG: ts },
        cwd: empty,
      });
      expect(fromEnv.path?.endsWith("hors.config.ts")).toBe(true);
      expect(fromEnv.config.policy.origin).toEqual(["public"]);

      const json = path.join(empty, "explicit.json");
      await writeFile(json, '{"maxAgeMs":1111}\n');
      const explicit = await resolveConfig({
        env: { HORS_CONFIG: ts },
        cwd: empty,
        configFile: json,
      });
      expect(explicit.path).toBe(json);
      expect(explicit.config.maxAgeMs).toBe(1111);
    });
  });

  it("rejects a non-object default export and mock mode in production", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "hors.config.mjs"), 'export default "nope";\n');
      await expectConfigInvalidAsync(
        () => resolveConfig({ env: {}, cwd: dir }),
        "config file default export must be a plain object",
      );
      await expectConfigInvalidAsync(
        () =>
          resolveConfig({
            env: { NODE_ENV: "production", HORS_MOCK: "1" },
            cwd: dir,
            configFile: false,
          }),
        "dev.mockOrigin is not allowed when NODE_ENV is production",
      );
    });
  });

  it("snapshots env before the config module runs", async () => {
    await withTempDir(async (dir) => {
      const env: Record<string, string | undefined> = { NODE_ENV: "production" };
      (globalThis as { __hors_env?: typeof env }).__hors_env = env;
      const file = path.join(dir, "mutate.mjs");
      await writeFile(file, 'globalThis.__hors_env.HORS_MOCK = "1";\nexport default {};\n');
      try {
        const resolved = await resolveConfig({ env, cwd: dir, configFile: file });
        expect(resolved.config.mock).toBe(false);
        expect(env.HORS_MOCK).toBe("1");
      } finally {
        delete (globalThis as { __hors_env?: unknown }).__hors_env;
      }
    });
  });

  it("returns the same object from defineConfig", () => {
    const config = { owner: "auto" as const };
    expect(defineConfig(config)).toBe(config);
  });
});
