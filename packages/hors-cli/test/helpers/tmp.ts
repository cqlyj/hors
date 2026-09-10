import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempDir(
  run: (dir: string) => Promise<void>,
  parent = tmpdir(),
): Promise<void> {
  const dir = await mkdtemp(join(parent, "hors-cli-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
