/**
 * Minimal GitHub REST client for the review loop.
 *
 * Capabilities used by the orchestrator:
 *   - fetch a pull request's unified diff
 *   - publish a review with a summary body + inline comments
 *
 * Least privilege: this client only reads diffs and writes reviews/comments. It
 * never pushes code. In dryRun mode it performs no network calls and returns the
 * payload it *would* have sent — used for shadow mode and offline tests.
 */

import type { Finding, ReviewResult } from "../types.js";
import type { PullRequestRef } from "./events.js";
import { log } from "../util/logger.js";

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface GitHubReviewPayload {
  commit_id: string;
  body: string;
  event: ReviewEvent;
  comments: ReviewComment[];
}

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  dryRun?: boolean;
  /** Max inline comments to attach (GitHub rejects very large reviews). */
  maxComments?: number;
}

export interface PostReviewOutcome {
  posted: boolean;
  dryRun: boolean;
  payload: GitHubReviewPayload;
  url?: string;
}

export class GitHubClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly dryRun: boolean;
  private readonly maxComments: number;

  constructor(opts: GitHubClientOptions = {}) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.dryRun = opts.dryRun ?? !opts.token;
    this.maxComments = opts.maxComments ?? 40;
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  private headers(accept = "application/vnd.github+json"): Record<string, string> {
    const h: Record<string, string> = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "breacherx/0.2",
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Fetch the unified diff for a PR (text). Throws on transport/HTTP error. */
  async fetchPullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
    if (this.dryRun) {
      throw new Error("fetchPullRequestDiff requires a token (not available in dryRun)");
    }
    const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${number}`;
    const res = await fetch(url, { headers: this.headers("application/vnd.github.v3.diff") });
    if (!res.ok) {
      throw new Error(`GitHub diff fetch failed: ${res.status} ${await res.text()}`);
    }
    return res.text();
  }

  /** Publish a review built from the pipeline result. */
  async postReview(
    pr: PullRequestRef,
    result: ReviewResult,
    opts: { autoApprove?: boolean } = {},
  ): Promise<PostReviewOutcome> {
    const payload = buildReviewPayload(pr, result, {
      autoApprove: opts.autoApprove ?? false,
      maxComments: this.maxComments,
    });

    if (this.dryRun) {
      log.info(
        `[dryRun] would post ${payload.event} review to ${pr.fullName}#${pr.number} ` +
          `with ${payload.comments.length} inline comment(s)`,
      );
      return { posted: false, dryRun: true, payload };
    }

    const url = `${this.baseUrl}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`GitHub postReview failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { html_url?: string };
    return { posted: true, dryRun: false, payload, url: json.html_url };
  }
}

const SEVERITY_EMOJI: Record<Finding["severity"], string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  info: "⚪",
};

export function findingToComment(f: Finding): ReviewComment {
  const lines: string[] = [];
  lines.push(`${SEVERITY_EMOJI[f.severity]} **${f.severity.toUpperCase()} · ${f.ruleId}**`);
  lines.push("");
  lines.push(f.problem);
  if (f.impact) lines.push(`\n_Impact:_ ${f.impact}`);
  lines.push(
    `\n_Confidence ${(f.calibratedConfidence * 100).toFixed(0)}% · ${f.verificationStatus} · ` +
      `${f.analyzerResult ?? f.source}_`,
  );
  if (f.suggestedPatch) {
    lines.push("\n```suggestion");
    lines.push(f.suggestedPatch);
    lines.push("```");
  }
  return { path: f.filePath, line: f.endLine, side: "RIGHT", body: lines.join("\n") };
}

export function buildReviewPayload(
  pr: PullRequestRef,
  result: ReviewResult,
  opts: { autoApprove: boolean; maxComments: number },
): GitHubReviewPayload {
  const comments = result.findings.slice(0, opts.maxComments).map(findingToComment);

  let event: ReviewEvent;
  if (result.reviewStatus === "changes_requested") event = "REQUEST_CHANGES";
  else if (result.reviewStatus === "approved") event = opts.autoApprove ? "APPROVE" : "COMMENT";
  else event = "COMMENT";

  const overflowNote =
    result.findings.length > opts.maxComments
      ? `\n\n_Showing ${opts.maxComments} of ${result.findings.length} findings; see full report._`
      : "";

  return {
    commit_id: pr.headSha,
    body: `## BreacherX review\n\n${result.summary}${overflowNote}`,
    event,
    comments,
  };
}
