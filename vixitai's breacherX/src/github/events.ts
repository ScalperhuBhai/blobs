/**
 * Parse and validate GitHub webhook payloads into internal review jobs.
 *
 * We only act on pull_request events whose action warrants a (re)review:
 * opened, reopened, synchronize (new commits), ready_for_review. Everything
 * else is acknowledged and ignored. Payload fields are treated as untrusted.
 */

export interface PullRequestRef {
  owner: string;
  repo: string;
  fullName: string;
  number: number;
  baseSha: string;
  headSha: string;
  title: string;
  draft: boolean;
}

export interface WebhookParseResult {
  kind: "review" | "ignored";
  reason?: string;
  event: string;
  deliveryId: string;
  pr?: PullRequestRef;
}

const REVIEWABLE_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

interface RawPrPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    title?: string;
    draft?: boolean;
    base?: { sha?: string };
    head?: { sha?: string };
  };
  repository?: {
    name?: string;
    full_name?: string;
    owner?: { login?: string };
  };
}

export function parseWebhook(
  eventName: string,
  deliveryId: string,
  body: unknown,
): WebhookParseResult {
  const base: WebhookParseResult = { kind: "ignored", event: eventName, deliveryId };

  if (eventName === "ping") {
    return { ...base, reason: "ping" };
  }
  if (eventName !== "pull_request") {
    return { ...base, reason: `unhandled event: ${eventName}` };
  }

  const payload = body as RawPrPayload;
  const action = payload.action ?? "";
  if (!REVIEWABLE_ACTIONS.has(action)) {
    return { ...base, reason: `unhandled action: ${action}` };
  }

  const pr = payload.pull_request;
  const repo = payload.repository;
  const owner = repo?.owner?.login;
  const name = repo?.name;
  const number = pr?.number ?? payload.number;

  if (!owner || !name || !number || !pr?.head?.sha || !pr?.base?.sha) {
    return { ...base, reason: "missing required pull_request fields" };
  }

  if (pr.draft && action !== "ready_for_review") {
    return { ...base, reason: "draft PR" };
  }

  return {
    kind: "review",
    event: eventName,
    deliveryId,
    pr: {
      owner,
      repo: name,
      fullName: repo?.full_name ?? `${owner}/${name}`,
      number,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      title: pr.title ?? "",
      draft: Boolean(pr.draft),
    },
  };
}
