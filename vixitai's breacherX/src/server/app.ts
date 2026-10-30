/**
 * Application wiring: queue + orchestrator + GitHub client + webhook handling.
 *
 * `createApp` builds the pieces and returns a small facade the HTTP server (or a
 * test) drives. The webhook handler verifies the signature, parses the event,
 * enqueues idempotently, and processing is kicked asynchronously so the webhook
 * can return 202 quickly (GitHub expects a fast ack).
 */

import type { Config } from "../config.js";
import { GitHubClient } from "../github/client.js";
import { verifySignature } from "../github/signature.js";
import { parseWebhook } from "../github/events.js";
import { RunStore } from "../db/store.js";
import { InMemoryQueue, type Queue, type ReviewJob } from "./queue.js";
import { Orchestrator, type DiffSource, type JobResult } from "./orchestrator.js";
import { log } from "../util/logger.js";

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface App {
  config: Config;
  queue: Queue;
  orchestrator: Orchestrator;
  client: GitHubClient;
  store: RunStore;
  /** Handle a raw webhook delivery. Verifies signature, enqueues, kicks drain. */
  handleWebhook(
    eventName: string,
    deliveryId: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<WebhookResponse>;
  /** Process pending jobs now (awaitable; used by tests and the drain loop). */
  drain(): Promise<JobResult[]>;
}

export interface CreateAppDeps {
  queue?: Queue;
  client?: GitHubClient;
  diffSource?: DiffSource;
  store?: RunStore;
  /** When false, handleWebhook enqueues but does not auto-process (tests). Default true. */
  autoDrain?: boolean;
}

export function createApp(config: Config, deps: CreateAppDeps = {}): App {
  const queue = deps.queue ?? new InMemoryQueue();
  const store = deps.store ?? new RunStore(config.dataDir);
  const client =
    deps.client ??
    new GitHubClient({
      token: config.githubToken,
      baseUrl: config.githubApiUrl,
      dryRun: !config.githubToken,
      maxComments: config.maxFindings,
    });
  const orchestrator = new Orchestrator({
    config,
    queue,
    client,
    diffSource: deps.diffSource,
    autoApprove: config.autoApprove,
    store,
  });

  let draining = false;
  async function drain(): Promise<JobResult[]> {
    if (draining) return [];
    draining = true;
    try {
      return await orchestrator.drain();
    } finally {
      draining = false;
    }
  }

  async function handleWebhook(
    eventName: string,
    deliveryId: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<WebhookResponse> {
    // Signature is a launch blocker: refuse unsigned/invalid deliveries when a
    // secret is configured. If no secret is set we warn loudly and accept
    // (dev-only convenience).
    if (config.webhookSecret) {
      if (!verifySignature(config.webhookSecret, rawBody, signature)) {
        log.warn(`rejected webhook ${deliveryId}: bad signature`);
        return { status: 401, body: { error: "invalid signature" } };
      }
    } else {
      log.warn("BREACHERX_WEBHOOK_SECRET not set; accepting unsigned webhook (dev only)");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }

    const parsed = parseWebhook(eventName, deliveryId, payload);
    if (parsed.kind === "ignored" || !parsed.pr) {
      return { status: 202, body: { accepted: false, reason: parsed.reason ?? "ignored" } };
    }

    const job: ReviewJob = {
      deliveryId,
      owner: parsed.pr.owner,
      repo: parsed.pr.repo,
      fullName: parsed.pr.fullName,
      number: parsed.pr.number,
      baseSha: parsed.pr.baseSha,
      headSha: parsed.pr.headSha,
      title: parsed.pr.title,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };

    const enqueued = queue.enqueue(job);
    if (!enqueued) {
      return { status: 202, body: { accepted: false, reason: "duplicate delivery" } };
    }

    // Fire-and-forget processing; webhook returns immediately.
    if (deps.autoDrain !== false) {
      void drain().catch((err) => log.error("drain error:", (err as Error).message));
    }

    return {
      status: 202,
      body: { accepted: true, job: `${job.fullName}#${job.number}@${job.headSha.slice(0, 8)}` },
    };
  }

  return { config, queue, orchestrator, client, store, handleWebhook, drain };
}
