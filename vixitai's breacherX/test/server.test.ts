import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSignature, verifySignature } from "../src/github/signature.js";
import { parseWebhook } from "../src/github/events.js";
import { InMemoryQueue, jobContentKey, type ReviewJob } from "../src/server/queue.js";
import { createApp } from "../src/server/app.js";
import { GitHubClient } from "../src/github/client.js";
import { loadConfig } from "../src/config.js";

const DIFF = `diff --git a/app/run.py b/app/run.py
new file mode 100644
--- /dev/null
+++ b/app/run.py
@@ -0,0 +1,3 @@
+def run(cmd):
+    return eval(cmd)
+# end
`;

function prPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: "opened",
    pull_request: {
      number: 7,
      title: "add runner",
      draft: false,
      base: { sha: "base123" },
      head: { sha: "head456" },
    },
    repository: { name: "blobs", full_name: "acme/blobs", owner: { login: "acme" } },
    ...overrides,
  };
}

test("signature verify accepts matching and rejects tampered", () => {
  const secret = "s3cr3t";
  const body = Buffer.from(JSON.stringify(prPayload()));
  const sig = computeSignature(secret, body);
  assert.ok(verifySignature(secret, body, sig));
  assert.ok(!verifySignature(secret, body, "sha256=deadbeef"));
  assert.ok(!verifySignature(secret, Buffer.concat([body, Buffer.from("x")]), sig));
  assert.ok(!verifySignature(secret, body, undefined));
});

test("parseWebhook routes reviewable actions and ignores others", () => {
  const review = parseWebhook("pull_request", "d1", prPayload());
  assert.equal(review.kind, "review");
  assert.equal(review.pr?.number, 7);
  assert.equal(review.pr?.headSha, "head456");

  assert.equal(parseWebhook("pull_request", "d2", prPayload({ action: "closed" })).kind, "ignored");
  assert.equal(parseWebhook("ping", "d3", {}).kind, "ignored");
  const draft = parseWebhook("pull_request", "d4", prPayload({ pull_request: { number: 7, draft: true, base: { sha: "b" }, head: { sha: "h" } } }));
  assert.equal(draft.kind, "ignored");
});

test("queue dedupes by delivery id and by content key", () => {
  const q = new InMemoryQueue();
  const base: ReviewJob = {
    deliveryId: "d1", owner: "acme", repo: "blobs", fullName: "acme/blobs",
    number: 7, baseSha: "b", headSha: "h", title: "t", enqueuedAt: "now", attempts: 0,
  };
  assert.ok(q.enqueue(base));
  assert.ok(!q.enqueue(base)); // same delivery id
  assert.ok(!q.enqueue({ ...base, deliveryId: "d2" })); // same content key
  assert.ok(q.enqueue({ ...base, deliveryId: "d3", headSha: "h2" })); // new head
  assert.equal(q.size(), 2);
  assert.equal(jobContentKey(base), "acme/blobs#7@h");
});

test("queue retries then dead-letters after max attempts", () => {
  const q = new InMemoryQueue(2);
  const job: ReviewJob = {
    deliveryId: "d1", owner: "a", repo: "b", fullName: "a/b",
    number: 1, baseSha: "b", headSha: "h", title: "t", enqueuedAt: "now", attempts: 0,
  };
  q.enqueue(job);
  let j = q.dequeue()!; q.nack(j.deliveryId, "boom"); // attempt 1 -> requeue
  j = q.dequeue()!; q.nack(j.deliveryId, "boom again"); // attempt 2 -> DLQ
  assert.equal(q.size(), 0);
  assert.equal(q.deadLetters().length, 1);
  assert.equal(q.deadLetters()[0]!.error, "boom again");
});

test("end-to-end webhook -> review -> dry-run post", async () => {
  const secret = "whsec";
  const config = loadConfig({ modelProvider: "mock", webhookSecret: secret, githubToken: undefined, dataDir: "/tmp/breacherx-test-data" });
  const client = new GitHubClient({ dryRun: true });
  const app = createApp(config, {
    client,
    diffSource: { fetchPullRequestDiff: async () => DIFF },
    autoDrain: false,
  });

  const raw = Buffer.from(JSON.stringify(prPayload()));
  const sig = computeSignature(secret, raw);
  const resp = await app.handleWebhook("pull_request", "deliv-1", raw, sig);
  assert.equal(resp.status, 202);
  assert.equal(resp.body.accepted, true);

  const results = await app.drain();
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.ok(r.result.findings.some((f) => f.ruleId.includes("eval")));
  assert.equal(r.result.reviewStatus, "changes_requested");
  assert.equal(r.outcome.dryRun, true);
  assert.equal(r.outcome.payload.event, "REQUEST_CHANGES");
  assert.ok(r.outcome.payload.comments.length >= 1);
  assert.equal(r.outcome.payload.comments[0]!.side, "RIGHT");
});

test("webhook with bad signature is rejected", async () => {
  const config = loadConfig({ webhookSecret: "right", dataDir: "/tmp/breacherx-test-data" });
  const app = createApp(config, { client: new GitHubClient({ dryRun: true }), diffSource: { fetchPullRequestDiff: async () => DIFF } });
  const raw = Buffer.from(JSON.stringify(prPayload()));
  const resp = await app.handleWebhook("pull_request", "deliv-2", raw, "sha256=wrong");
  assert.equal(resp.status, 401);
});
