import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hors-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withTempHome(run: (dir: string) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    vi.stubEnv("HORS_HOME", dir);
    await run(dir);
  });
}
