/** Helpers for reading head-file context from a working tree (best-effort). */

import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { log } from "./logger.js";

export async function readHeadFile(
  repoPath: string | undefined,
  relPath: string,
): Promise<string | undefined> {
  if (!repoPath) return undefined;
  if (relPath === "/dev/null") return undefined;
  const full = isAbsolute(relPath) ? relPath : join(repoPath, relPath);
  try {
    return await readFile(full, "utf8");
  } catch (err) {
    log.debug(`could not read head file ${full}:`, (err as Error).message);
    return undefined;
  }
}
