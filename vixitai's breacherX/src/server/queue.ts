/**
 * Job queue abstraction (blueprint: "enqueue idempotently", SQS + DLQ in prod).
 *
 * The interface is deliberately SQS-shaped so an SQS-backed implementation can
 * drop in later. The in-memory implementation gives idempotency (dedupe by job
 * key), at-least-once delivery with bounded retries, and a dead-letter list.
 */

export interface ReviewJob {
  /** Idempotency key: webhook delivery id. */
  deliveryId: string;
  owner: string;
  repo: string;
  fullName: string;
  number: number;
  baseSha: string;
  headSha: string;
  title: string;
  enqueuedAt: string;
  attempts: number;
}

export interface Queue {
  /** Enqueue a job; returns false if a duplicate key was already seen. */
  enqueue(job: ReviewJob): boolean;
  /** Take the next pending job, or undefined if none. */
  dequeue(): ReviewJob | undefined;
  /** Mark a dequeued job as succeeded. */
  ack(deliveryId: string): void;
  /** Mark a dequeued job as failed; re-enqueues until maxAttempts, then DLQs. */
  nack(deliveryId: string, error: string): void;
  size(): number;
  deadLetters(): Array<{ job: ReviewJob; error: string }>;
}

/** A stable content key so the same head commit is not reviewed twice. */
export function jobContentKey(job: Pick<ReviewJob, "fullName" | "number" | "headSha">): string {
  return `${job.fullName}#${job.number}@${job.headSha}`;
}

export class InMemoryQueue implements Queue {
  private pending: ReviewJob[] = [];
  private readonly seenDeliveries = new Set<string>();
  private readonly seenContent = new Set<string>();
  private readonly inFlight = new Map<string, ReviewJob>();
  private readonly dlq: Array<{ job: ReviewJob; error: string }> = [];
  private readonly maxAttempts: number;

  constructor(maxAttempts = 3) {
    this.maxAttempts = maxAttempts;
  }

  enqueue(job: ReviewJob): boolean {
    const contentKey = jobContentKey(job);
    if (this.seenDeliveries.has(job.deliveryId) || this.seenContent.has(contentKey)) {
      return false;
    }
    this.seenDeliveries.add(job.deliveryId);
    this.seenContent.add(contentKey);
    this.pending.push({ ...job, attempts: 0 });
    return true;
  }

  dequeue(): ReviewJob | undefined {
    const job = this.pending.shift();
    if (!job) return undefined;
    job.attempts += 1;
    this.inFlight.set(job.deliveryId, job);
    return job;
  }

  ack(deliveryId: string): void {
    this.inFlight.delete(deliveryId);
  }

  nack(deliveryId: string, error: string): void {
    const job = this.inFlight.get(deliveryId);
    if (!job) return;
    this.inFlight.delete(deliveryId);
    if (job.attempts >= this.maxAttempts) {
      this.dlq.push({ job, error });
    } else {
      this.pending.push(job);
    }
  }

  size(): number {
    return this.pending.length;
  }

  deadLetters(): Array<{ job: ReviewJob; error: string }> {
    return [...this.dlq];
  }
}
