#!/usr/bin/env node
/**
 * BreacherX control-plane server entry point.
 *
 *   breacherx-server            start the webhook/review HTTP server
 *
 * Env (see .env.example): BREACHERX_WEBHOOK_SECRET, GITHUB_TOKEN, PORT,
 * BREACHERX_MODEL_PROVIDER, etc. Without a GITHUB_TOKEN the client runs in
 * dry-run (shadow) mode: it reviews but does not post.
 */

import { loadConfig } from "../config.js";
import { setLogLevel, log } from "../util/logger.js";
import { createApp } from "./app.js";
import { createHttpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  if (!config.webhookSecret) {
    log.warn("BREACHERX_WEBHOOK_SECRET is not set — webhook signatures will not be enforced.");
  }
  if (!config.githubToken) {
    log.warn("No GITHUB_TOKEN — running in dry-run (shadow) mode; reviews are computed but not posted.");
  }

  const app = createApp(config);
  const server = createHttpServer(app);

  server.listen(config.port, () => {
    log.info(`BreacherX control plane listening on :${config.port}`);
    log.info(`  POST /webhook  ·  GET /healthz  ·  GET /reviews  ·  GET /dlq`);
    log.info(`  provider=${config.modelProvider} dryRun=${app.client.isDryRun}`);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log.info(`${sig} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
