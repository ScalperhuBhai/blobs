/**
 * Developer feedback store + calibration persistence (Phase 3 learn loop).
 *
 * Feedback labels are appended as JSONL; calibration tables are written as JSON.
 * `fitCalibration` joins feedback with stored runs to recover each finding's
 * rule/source, then fits a CalibrationModel. In production these are the
 * `finding_feedback` and `eval_runs`/calibration artifacts in Postgres.
 */

import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunStore } from "./store.js";
import {
  CalibrationModel,
  labelToUseful,
  type CalibrationTable,
  type FeedbackLabel,
  type LabelOutcome,
} from "../pipeline/calibration.js";
import { log } from "../util/logger.js";

export interface FeedbackEntry {
  reviewId: string;
  findingId: string;
  label: FeedbackLabel;
  actor?: string;
  at: string;
}

const CAL_FILE = "calibration.json";
const FEEDBACK_FILE = join("feedback", "feedback.jsonl");

export class FeedbackStore {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async record(entry: Omit<FeedbackEntry, "at">): Promise<void> {
    const path = join(this.dataDir, FEEDBACK_FILE);
    await mkdir(join(this.dataDir, "feedback"), { recursive: true });
    const full: FeedbackEntry = { ...entry, at: new Date().toISOString() };
    await appendFile(path, JSON.stringify(full) + "\n", "utf8");
  }

  async list(): Promise<FeedbackEntry[]> {
    try {
      const raw = await readFile(join(this.dataDir, FEEDBACK_FILE), "utf8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as FeedbackEntry);
    } catch {
      return [];
    }
  }
}

export async function loadCalibration(dataDir: string, minSamples = 5): Promise<CalibrationModel> {
  try {
    const raw = await readFile(join(dataDir, CAL_FILE), "utf8");
    const table = JSON.parse(raw) as CalibrationTable;
    return new CalibrationModel(table);
  } catch {
    return CalibrationModel.empty(minSamples);
  }
}

export async function saveCalibration(dataDir: string, model: CalibrationModel): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, CAL_FILE);
  await writeFile(path, JSON.stringify(model.data, null, 2), "utf8");
  return path;
}

export interface FitResult {
  model: CalibrationModel;
  outcomes: LabelOutcome[];
  unmatched: number;
}

/** Join feedback with stored runs to fit a calibration model. */
export async function fitCalibration(dataDir: string, minSamples = 5): Promise<FitResult> {
  const feedbackStore = new FeedbackStore(dataDir);
  const runStore = new RunStore(dataDir);
  const feedback = await feedbackStore.list();

  const runCache = new Map<string, Awaited<ReturnType<RunStore["load"]>>>();
  const outcomes: LabelOutcome[] = [];
  let unmatched = 0;

  for (const fb of feedback) {
    if (!runCache.has(fb.reviewId)) {
      runCache.set(fb.reviewId, await runStore.load(fb.reviewId));
    }
    const run = runCache.get(fb.reviewId);
    if (!run) {
      unmatched++;
      continue;
    }
    const finding =
      run.findings.find((f) => f.id === fb.findingId) ??
      run.suppressed.find((f) => f.id === fb.findingId);
    if (!finding) {
      unmatched++;
      continue;
    }
    outcomes.push({ ruleId: finding.ruleId, source: finding.source, useful: labelToUseful(fb.label) });
  }

  const model = CalibrationModel.fromLabels(outcomes, minSamples);
  log.info(`fit calibration from ${outcomes.length} labeled outcome(s), ${unmatched} unmatched`);
  return { model, outcomes, unmatched };
}
