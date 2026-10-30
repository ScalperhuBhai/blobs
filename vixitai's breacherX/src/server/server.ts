/**
 * HTTP server for the control plane (node:http, no framework).
 *
 * Routes:
 *   GET  /healthz           liveness + queue depth
 *   POST /webhook           GitHub webhook receiver (signed)
 *   GET  /reviews           list stored run ids
 *   GET  /reviews/:id       fetch a stored run
 *   GET  /dlq               dead-letter jobs
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { App } from "./app.js";
import { log } from "../util/logger.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // GitHub webhooks are well under this.

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

export function createHttpServer(app: App): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          queueDepth: app.queue.size(),
          deadLetters: app.queue.deadLetters().length,
          provider: app.config.modelProvider,
          dryRun: app.client.isDryRun,
        });
        return;
      }

      if (method === "POST" && path === "/webhook") {
        const raw = await readRawBody(req);
        const eventName = header(req, "x-github-event") ?? "unknown";
        const deliveryId = header(req, "x-github-delivery") ?? `local-${Date.now()}`;
        const signature = header(req, "x-hub-signature-256");
        const result = await app.handleWebhook(eventName, deliveryId, raw, signature);
        sendJson(res, result.status, result.body);
        return;
      }

      if (method === "GET" && path === "/reviews") {
        const ids = await app.store.list();
        sendJson(res, 200, { reviews: ids });
        return;
      }

      if (method === "GET" && path.startsWith("/reviews/")) {
        const id = decodeURIComponent(path.slice("/reviews/".length));
        const run = await app.store.load(id);
        if (!run) sendJson(res, 404, { error: "not found" });
        else sendJson(res, 200, run);
        return;
      }

      if (method === "GET" && path === "/dlq") {
        sendJson(res, 200, { deadLetters: app.queue.deadLetters() });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      log.error("request error:", (err as Error).message);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
