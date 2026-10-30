import { test } from "node:test";
import assert from "node:assert/strict";
import { CalibrationModel, labelToUseful, type LabelOutcome } from "../src/pipeline/calibration.js";

test("labelToUseful maps labels correctly", () => {
  assert.equal(labelToUseful("useful"), true);
  assert.equal(labelToUseful("fixed"), true);
  assert.equal(labelToUseful("not_useful"), false);
  assert.equal(labelToUseful("false_positive"), false);
});

test("empty model makes no adjustment", () => {
  const m = CalibrationModel.empty();
  assert.equal(m.reliability("any/rule", "model"), undefined);
  assert.equal(m.adjust(0.7, "any/rule", "model"), 0.7);
});

test("fromLabels learns per-rule precision above minSamples", () => {
  const labels: LabelOutcome[] = [];
  // model/noisy: mostly false positives (1/6 useful)
  for (let i = 0; i < 5; i++) labels.push({ ruleId: "model/noisy", source: "model", useful: false });
  labels.push({ ruleId: "model/noisy", source: "model", useful: true });
  // builtin/solid: mostly useful (5/6)
  for (let i = 0; i < 5; i++) labels.push({ ruleId: "builtin/solid", source: "builtin", useful: true });
  labels.push({ ruleId: "builtin/solid", source: "builtin", useful: false });

  const m = CalibrationModel.fromLabels(labels, 5);
  const noisy = m.reliability("model/noisy", "model")!;
  const solid = m.reliability("builtin/solid", "builtin")!;
  assert.ok(noisy < 0.4, `noisy reliability ${noisy}`);
  assert.ok(solid > 0.6, `solid reliability ${solid}`);

  // Adjustment pulls confidence toward measured precision.
  assert.ok(m.adjust(0.8, "model/noisy", "model") < 0.8);
  assert.ok(m.adjust(0.4, "builtin/solid", "builtin") > 0.4);
});

test("falls back to source-level estimate when rule has too few samples", () => {
  const labels: LabelOutcome[] = [];
  for (let i = 0; i < 8; i++) labels.push({ ruleId: `model/r${i}`, source: "model", useful: false });
  const m = CalibrationModel.fromLabels(labels, 5);
  // A brand-new rule has no samples, but the "model" source does.
  assert.equal(m.reliability("model/brand-new", "model") !== undefined, true);
  assert.ok((m.reliability("model/brand-new", "model") ?? 1) < 0.3);
});
