#!/usr/bin/env node
/**
 * BreacherX CLI.
 *
 *   breacherx review <diff-file|-> [options]   Run a review on a unified diff.
 *   breacherx bench [--set <name>] [options]   Run the accuracy benchmark.
 *   breacherx runs                             List stored run ids.
 *   breacherx version | help
 *
 * Reads the diff from a file or stdin ("-"). Prints the chosen format to stdout;
 * logs go to stderr. Exits non-zero when the verdict is changes_requested
 * (useful as a CI gate), unless --no-fail is passed.
 */

import { readFile } from "node:fs/promises";
import { loadConfig, type Config } from "./config.js";
import { setLogLevel, log } from "./util/logger.js";
import { runReview } from "./pipeline/pipeline.js";
import { renderMarkdown, renderText } from "./pipeline/publish.js";
import { RunStore } from "./db/store.js";
import { FeedbackStore, fitCalibration, saveCalibration } from "./db/feedback.js";
import type { FeedbackLabel } from "./pipeline/calibration.js";
import { runBenchmark, formatBenchReport } from "../bench/harness.js";

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      (flags._ as string[]).push(a);
    }
  }
  return flags;
}

async function readInput(path: string): Promise<string> {
  if (path === "-" || path === "/dev/stdin") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(path, "utf8");
}

function configFromFlags(flags: Flags): Config {
  const overrides: Partial<Config> = {};
  if (typeof flags.provider === "string") {
    overrides.modelProvider = flags.provider === "anthropic" ? "anthropic" : "mock";
  }
  if (typeof flags["min-confidence"] === "string") {
    overrides.minConfidence = Number(flags["min-confidence"]);
  }
  if (flags["all-lines"] === true) overrides.changedLinesOnly = false;
  if (typeof flags["max-findings"] === "string") {
    overrides.maxFindings = Number(flags["max-findings"]);
  }
  if (flags["run-tests"] === true) overrides.enableTestReproduction = true;
  if (typeof flags["test-command"] === "string") {
    overrides.testCommand = flags["test-command"];
    overrides.enableTestReproduction = true;
  }
  const config = loadConfig(overrides);
  if (typeof flags["log-level"] === "string") config.logLevel = flags["log-level"] as Config["logLevel"];
  return config;
}

const HELP = `BreacherX — evidence-based AI code review

Usage:
  breacherx review <diff-file|-> [options]
  breacherx bench [--set regression] [options]
  breacherx feedback --review <id> --finding <id> --label <label>
  breacherx calibrate [--min-samples <n>]
  breacherx runs
  breacherx version
  breacherx help

Feedback labels: useful | fixed | not_useful | false_positive
calibrate fits per-rule precision from feedback and writes calibration.json,
which the review pipeline then blends into confidence (learn + measure loop).

Options (review):
  --repo <path>            Working tree root for full-file context + external analyzers
  --format md|json|text    Output format (default: md)
  --provider mock|anthropic
  --min-confidence <0..1>  Publish threshold (default 0.55)
  --max-findings <n>       Cap published findings
  --all-lines              Do not restrict findings to changed lines
  --config <file>          Path to a .breacherx.json (else discovered under --repo)
  --run-tests              Run the project's tests as reproduction evidence (opt-in)
  --test-command <cmd>     Test command to run with --run-tests (e.g. "npm test")
  --review-id <id>         Logical id for the review (PR number / sha)
  --out <file>             Also write the formatted output to this file
  --no-save                Do not persist the run
  --no-fail                Always exit 0 even on changes_requested
  --log-level <level>      debug|info|warn|error|silent

Env: see .env.example (model provider, thresholds, data dir).`;

async function cmdReview(flags: Flags): Promise<number> {
  const target = (flags._ as string[])[1];
  if (!target) {
    log.error("review requires a diff file path (or - for stdin)");
    return 2;
  }
  const config = configFromFlags(flags);
  setLogLevel(config.logLevel);

  const diffText = await readInput(target);
  if (!diffText.trim()) {
    log.error("empty diff input");
    return 2;
  }

  const result = await runReview(
    {
      diffText,
      repoPath: typeof flags.repo === "string" ? flags.repo : undefined,
      reviewId: typeof flags["review-id"] === "string" ? flags["review-id"] : undefined,
      configPath: typeof flags.config === "string" ? flags.config : undefined,
    },
    config,
  );

  const format = (typeof flags.format === "string" ? flags.format : "md").toLowerCase();
  let output: string;
  if (format === "json") output = JSON.stringify(result, null, 2);
  else if (format === "text") output = renderText(result);
  else output = renderMarkdown(result);

  process.stdout.write(output + "\n");

  if (typeof flags.out === "string") {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(flags.out, output, "utf8");
    log.info(`wrote output to ${flags.out}`);
  }

  if (flags.save !== false && flags["no-save"] !== true) {
    const store = new RunStore(config.dataDir);
    const file = await store.save(result);
    log.info(`run saved: ${file}`);
  }

  log.info(
    `verdict=${result.reviewStatus} published=${result.findings.length} ` +
      `suppressed=${result.suppressed.length} cost=$${result.cost.usd.toFixed(4)}`,
  );

  if (result.reviewStatus === "changes_requested" && flags["no-fail"] !== true) return 1;
  return 0;
}

async function cmdBench(flags: Flags): Promise<number> {
  const config = configFromFlags(flags);
  setLogLevel(config.logLevel);
  const set = typeof flags.set === "string" ? flags.set : "regression";
  const report = await runBenchmark(set, config);
  const format = (typeof flags.format === "string" ? flags.format : "text").toLowerCase();
  if (format === "json") process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatBenchReport(report) + "\n");
  // Release gate: fail if precision drops below a floor (configurable later).
  const floor = typeof flags["min-precision"] === "string" ? Number(flags["min-precision"]) : 0;
  if (report.metrics.precision < floor) return 1;
  return 0;
}

const VALID_LABELS = new Set<FeedbackLabel>(["useful", "fixed", "not_useful", "false_positive"]);

async function cmdFeedback(flags: Flags): Promise<number> {
  const config = configFromFlags(flags);
  const reviewId = flags.review;
  const findingId = flags.finding;
  const label = flags.label;
  if (typeof reviewId !== "string" || typeof findingId !== "string" || typeof label !== "string") {
    log.error("feedback requires --review <id> --finding <id> --label <useful|fixed|not_useful|false_positive>");
    return 2;
  }
  if (!VALID_LABELS.has(label as FeedbackLabel)) {
    log.error(`invalid label '${label}'`);
    return 2;
  }
  const store = new FeedbackStore(config.dataDir);
  await store.record({
    reviewId,
    findingId,
    label: label as FeedbackLabel,
    actor: typeof flags.actor === "string" ? flags.actor : undefined,
  });
  process.stdout.write(`recorded ${label} for ${findingId} on ${reviewId}\n`);
  return 0;
}

async function cmdCalibrate(flags: Flags): Promise<number> {
  const config = configFromFlags(flags);
  setLogLevel(config.logLevel);
  const minSamples =
    typeof flags["min-samples"] === "string" ? Number(flags["min-samples"]) : 5;
  const { model, outcomes, unmatched } = await fitCalibration(config.dataDir, minSamples);
  const path = await saveCalibration(config.dataDir, model);
  const rulesWithData = Object.entries(model.data.byRule)
    .filter(([, c]) => c.total >= minSamples)
    .map(([rule, c]) => `  ${rule}: ${((c.useful / c.total) * 100).toFixed(0)}% useful (${c.total})`);
  process.stdout.write(
    `Calibration fit from ${outcomes.length} outcome(s) (${unmatched} unmatched), ` +
      `minSamples=${minSamples}\nsaved: ${path}\n` +
      (rulesWithData.length ? `Rules with enough data:\n${rulesWithData.join("\n")}\n` : "No rule has enough samples yet.\n"),
  );
  return 0;
}

async function cmdRuns(flags: Flags): Promise<number> {
  const config = configFromFlags(flags);
  const store = new RunStore(config.dataDir);
  const ids = await store.list();
  if (ids.length === 0) process.stdout.write("(no stored runs)\n");
  else process.stdout.write(ids.join("\n") + "\n");
  return 0;
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = (flags._ as string[])[0] ?? "help";
  switch (cmd) {
    case "review":
      return cmdReview(flags);
    case "bench":
      return cmdBench(flags);
    case "feedback":
      return cmdFeedback(flags);
    case "calibrate":
      return cmdCalibrate(flags);
    case "runs":
      return cmdRuns(flags);
    case "version":
      process.stdout.write("breacherx 0.1.0\n");
      return 0;
    case "help":
    default:
      process.stdout.write(HELP + "\n");
      return cmd === "help" ? 0 : 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
