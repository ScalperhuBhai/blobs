/**
 * Review orchestrator — the worker that drains the queue.
 *
 * For each job: fetch the PR diff, run the review pipeline, persist the run, and
 * publish a review (or a dry-run shadow result). Errors are reported back to the
 * queue for retry/DLQ. The GitHub client is injected so tests can supply a fake.
 */

import type { Config } from "../config.js";
import type { ReviewResult } from "../types.js";
import { runReview } from "../pipeline/pipeline.js";
import { RunStore } from "../db/store.js";
import { GitHubClient, type PostReviewOutcome } from "../github/client.js";
import type { PullRequestRef } from "../github/events.js";
import type { Queue, ReviewJob } from "./queue.js";
import { log } from "../util/logger.js";

export interface DiffSource {
  fetchPullRequestDiff(owner: string, repo: string, number: number): Promise<string>;
}

export interface OrchestratorOptions {
  config: Config;
  queue: Queue;
  client: GitHubClient;
  /** Override where diffs come from (defaults to the GitHub client). */
  diffSource?: DiffSource;
  autoApprove?: boolean;
  store?: RunStore;
}

export interface JobResult {
  job: ReviewJob;
  result: ReviewResult;
  outcome: PostReviewOutcome;
}

export class Orchestrator {
  private readonly opts: OrchestratorOptions;
  private readonly store: RunStore;
  private readonly diffSource: DiffSource;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.store = opts.store ?? new RunStore(opts.config.dataDir);
    this.diffSource = opts.diffSource ?? opts.client;
  }

  private prRef(job: ReviewJob): PullRequestRef {
    return {
      owner: job.owner,
      repo: job.repo,
      fullName: job.fullName,
      number: job.number,
      baseSha: job.baseSha,
      headSha: job.headSha,
      title: job.title,
      draft: false,
    };
  }

  /** Process exactly one job (fetch → review → publish). */
  async processJob(job: ReviewJob): Promise<JobResult> {
    log.info(`reviewing ${job.fullName}#${job.number} @ ${job.headSha.slice(0, 8)}`);
    const diffText = await this.diffSource.fetchPullRequestDiff(job.owner, job.repo, job.number);
    const result = await runReview(
      { diffText, reviewId: `${job.fullName}#${job.number}@${job.headSha.slice(0, 8)}` },
      this.opts.config,
    );
    await this.store.save(result);
    const outcome = await this.opts.client.postReview(this.prRef(job), result, {
      autoApprove: this.opts.autoApprove,
    });
    log.info(
      `${job.fullName}#${job.number}: ${result.reviewStatus}, ` +
        `${result.findings.length} finding(s), ${outcome.dryRun ? "dry-run" : "posted"}`,
    );
    return { job, result, outcome };
  }

  /** Drain all currently-pending jobs. Returns results for the ones that ran. */
  async drain(): Promise<JobResult[]> {
    const results: JobResult[] = [];
    for (;;) {
      const job = this.opts.queue.dequeue();
      if (!job) break;
      try {
        const r = await this.processJob(job);
        this.opts.queue.ack(job.deliveryId);
        results.push(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`job ${job.deliveryId} failed: ${msg}`);
        this.opts.queue.nack(job.deliveryId, msg);
      }
    }
    return results;
  }
}
