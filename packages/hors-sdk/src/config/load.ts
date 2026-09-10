import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HorsError } from "../errors.js";
import { isPlainObject } from "../plain.js";
import { type Env, envLayer, type LogLevelName, logLevelFrom, nonEmpty } from "./env.js";
import { type GateConfig, type HorsConfig, validateConfig } from "./schema.js";

const CONFIG_FILE_NAMES = [
  "hors.config.ts",
  "hors.config.mts",
  "hors.config.js",
  "hors.config.mjs",
  "hors.config.json",
] as const;

const CONFIG_EXTS = new Set([".ts", ".mts", ".js", ".mjs", ".json"]);

export interface LoadedConfigFile {
  readonly path: string;
  readonly config: unknown;
}

const NESTED_KEYS = new Set(["rpc", "cache", "dev", "functions", "services"]);

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

async function isFile(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isFile();
  } catch {
    return false;
  }
}

function mergeShallow(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    setOwn(merged, key, value);
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) {
      setOwn(merged, key, value);
    }
  }
  return merged;
}

async function readConfig(absolute: string): Promise<LoadedConfigFile> {
  if (path.extname(absolute) === ".json") {
    let text: string;
    try {
      text = await readFile(absolute, "utf8");
    } catch (error) {
      throw new HorsError("CONFIG_INVALID", `config file failed to load: ${absolute}`, undefined, {
        cause: error,
      });
    }
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    try {
      return { path: absolute, config: JSON.parse(text) };
    } catch {
      throw new HorsError("CONFIG_INVALID", `config file is not valid JSON: ${absolute}`);
    }
  }
  // WHY: the module system evaluates a given path once per process, so a config
  // file is loaded once; edits need a restart.
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(absolute).href);
  } catch (error) {
    for (let current: unknown = error; current !== undefined && current !== null; ) {
      if (current instanceof HorsError) {
        throw current;
      }
      current = current instanceof Error ? current.cause : undefined;
    }
    throw new HorsError("CONFIG_INVALID", `config file failed to load: ${absolute}`, undefined, {
      cause: error,
    });
  }
  if (
    loaded === null ||
    typeof loaded !== "object" ||
    !Object.hasOwn(loaded, "default") ||
    Reflect.get(loaded, "default") === undefined
  ) {
    throw new HorsError("CONFIG_INVALID", `config file has no default export: ${absolute}`);
  }
  const config = Reflect.get(loaded, "default");
  if (!isPlainObject(config)) {
    throw new HorsError(
      "CONFIG_INVALID",
      `config file default export must be a plain object: ${absolute}`,
    );
  }
  return { path: absolute, config };
}

export async function loadConfigFile(options: {
  readonly path?: string;
  readonly cwd: string;
}): Promise<LoadedConfigFile | undefined> {
  if (options.path !== undefined) {
    const absolute = path.resolve(options.cwd, options.path);
    if (!CONFIG_EXTS.has(path.extname(absolute))) {
      throw new HorsError(
        "CONFIG_INVALID",
        `config file must end in .ts, .mts, .js, .mjs or .json: ${absolute}`,
      );
    }
    if (!(await isFile(absolute))) {
      throw new HorsError("CONFIG_INVALID", `config file not found: ${absolute}`);
    }
    return readConfig(absolute);
  }
  for (const name of CONFIG_FILE_NAMES) {
    const absolute = path.resolve(options.cwd, name);
    if (await isFile(absolute)) {
      return readConfig(absolute);
    }
  }
  return undefined;
}

export function mergeLayers(layers: readonly unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    if (!isPlainObject(layer)) {
      throw new HorsError("CONFIG_INVALID", "config must be a plain object");
    }
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) {
        continue;
      }
      const current = result[key];
      if (NESTED_KEYS.has(key) && isPlainObject(current) && isPlainObject(value)) {
        setOwn(result, key, mergeShallow(current, value));
      } else {
        setOwn(result, key, value);
      }
    }
  }
  return result;
}

export interface ResolveConfigInput {
  readonly options?: HorsConfig;
  readonly env: Env;
  readonly cwd: string;
  readonly configFile?: string | false;
}

export interface ResolvedConfig {
  readonly config: GateConfig;
  readonly path: string | undefined;
  readonly logLevel: LogLevelName;
}

export async function loadConfig(input?: {
  cwd?: string;
  env?: Env;
  configFile?: string | false;
}): Promise<{ config: GateConfig; path: string | undefined }> {
  const resolved = await resolveConfig({
    env: input?.env ?? { ...process.env },
    cwd: input?.cwd ?? process.cwd(),
    configFile: input?.configFile,
  });
  return { config: resolved.config, path: resolved.path };
}

export async function resolveConfig(input: ResolveConfigInput): Promise<ResolvedConfig> {
  const env: Env = { ...input.env };
  const file =
    input.configFile === false
      ? undefined
      : await loadConfigFile({
          path: typeof input.configFile === "string" ? input.configFile : nonEmpty(env.HORS_CONFIG),
          cwd: input.cwd,
        });
  return {
    config: validateConfig(mergeLayers([file?.config, envLayer(env), input.options]), {
      nodeEnv: env.NODE_ENV,
    }),
    path: file?.path,
    logLevel: logLevelFrom(env),
  };
}
