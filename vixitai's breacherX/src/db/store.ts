/**
 * Run store.
 *
 * The production target is PostgreSQL + pgvector + S3 (see db/schema.sql). For a
 * zero-dependency local/dev experience, runs and findings are persisted as JSON
 * under BREACHERX_DATA_DIR so every review is auditable (inputs, outputs, model
 * version, cost, latency) — the "learn + measure" stage of the blueprint.
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewResult } from "../types.js";
import { log } from "../util/logger.js";

export class RunStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "runs");
  }

  async save(result: ReviewResult): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const safeId = result.reviewId.replace(/[^a-z0-9_-]+/gi, "_");
    const file = join(this.dir, `${safeId}.json`);
    const serializable = {
      ...result,
      // Sets are not JSON-serializable; findings already carry plain fields.
    };
    await writeFile(file, JSON.stringify(serializable, null, 2), "utf8");
    log.debug(`saved run to ${file}`);
    return file;
  }

  async load(reviewId: string): Promise<ReviewResult | undefined> {
    const safeId = reviewId.replace(/[^a-z0-9_-]+/gi, "_");
    try {
      const raw = await readFile(join(this.dir, `${safeId}.json`), "utf8");
      return JSON.parse(raw) as ReviewResult;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }
}
