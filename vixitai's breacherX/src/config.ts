/** Runtime configuration, resolved from environment with safe defaults. */

import type { LogLevel } from "./util/logger.js";

export type ModelProviderName = "mock" | "anthropic";

export interface Config {
  modelProvider: ModelProviderName;
  anthropicApiKey?: string;
  anthropicBaseUrl: string;
  discoveryModel: string;
  verifyModel: string;
  minConfidence: number;
  changedLinesOnly: boolean;
  maxFindings: number;
  /** Specialist discovery passes to run per file (blueprint stage 05). */
  discoveryPasses: string[];
  dataDir: string;
  logLevel: LogLevel;
  // --- Control plane / GitHub App ---
  webhookSecret?: string;
  githubToken?: string;
  githubApiUrl: string;
  autoApprove: boolean;
  port: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const provider = (env.BREACHERX_MODEL_PROVIDER as ModelProviderName) ?? "mock";
  const config: Config = {
    modelProvider: provider === "anthropic" ? "anthropic" : "mock",
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
    discoveryModel: env.BREACHERX_DISCOVERY_MODEL || "claude-haiku-4-5",
    verifyModel: env.BREACHERX_VERIFY_MODEL || "claude-opus-4-8",
    minConfidence: clamp01(num(env.BREACHERX_MIN_CONFIDENCE, 0.55)),
    changedLinesOnly: bool(env.BREACHERX_CHANGED_LINES_ONLY, true),
    maxFindings: Math.max(1, Math.trunc(num(env.BREACHERX_MAX_FINDINGS, 50))),
    discoveryPasses: parseList(
      env.BREACHERX_DISCOVERY_PASSES,
      ["correctness", "security", "reliability", "performance"],
    ),
    dataDir: env.BREACHERX_DATA_DIR || ".breacherx",
    logLevel: (env.BREACHERX_LOG_LEVEL as LogLevel) || "info",
    webhookSecret: env.BREACHERX_WEBHOOK_SECRET || undefined,
    githubToken: env.GITHUB_TOKEN || env.BREACHERX_GITHUB_TOKEN || undefined,
    githubApiUrl: env.GITHUB_API_URL || "https://api.github.com",
    autoApprove: bool(env.BREACHERX_AUTO_APPROVE, false),
    port: Math.trunc(num(env.PORT ?? env.BREACHERX_PORT, 8787)),
    ...overrides,
  };
  return config;
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
