/**
 * Confidence calibration (Phase 3).
 *
 * "A model's confidence score is not proof; calibrate against held-out labeled
 * examples." This model learns, from developer feedback, the historical
 * precision of each rule (and each source as a fallback) and uses it to pull a
 * finding's calibrated confidence toward its measured usefulness.
 *
 * Feedback label -> outcome:
 *   useful | fixed            -> true  (a real, useful finding)
 *   not_useful | false_positive -> false
 *
 * With too few samples for a rule, the source-level estimate is used; with too
 * few of those, no adjustment is made (the pipeline's default calibration holds).
 */

export type FeedbackLabel = "useful" | "fixed" | "not_useful" | "false_positive";

export interface LabelOutcome {
  ruleId: string;
  source: string;
  useful: boolean;
}

interface Counts {
  useful: number;
  total: number;
}

export interface CalibrationTable {
  byRule: Record<string, Counts>;
  bySource: Record<string, Counts>;
  minSamples: number;
  samples: number;
  generatedAt: string;
}

export function labelToUseful(label: FeedbackLabel): boolean {
  return label === "useful" || label === "fixed";
}

export class CalibrationModel {
  private readonly table: CalibrationTable;

  constructor(table: CalibrationTable) {
    this.table = table;
  }

  static empty(minSamples = 5): CalibrationModel {
    return new CalibrationModel({
      byRule: {},
      bySource: {},
      minSamples,
      samples: 0,
      generatedAt: new Date().toISOString(),
    });
  }

  static fromLabels(labels: LabelOutcome[], minSamples = 5): CalibrationModel {
    const byRule: Record<string, Counts> = {};
    const bySource: Record<string, Counts> = {};
    const bump = (map: Record<string, Counts>, key: string, useful: boolean) => {
      const c = (map[key] ??= { useful: 0, total: 0 });
      c.total++;
      if (useful) c.useful++;
    };
    for (const l of labels) {
      bump(byRule, l.ruleId, l.useful);
      bump(bySource, l.source, l.useful);
    }
    return new CalibrationModel({
      byRule,
      bySource,
      minSamples,
      samples: labels.length,
      generatedAt: new Date().toISOString(),
    });
  }

  get data(): CalibrationTable {
    return this.table;
  }

  /**
   * Historical precision estimate in [0,1] for a rule/source, or undefined when
   * there is insufficient data. Laplace-smoothed to avoid 0/1 extremes.
   */
  reliability(ruleId: string, source: string): number | undefined {
    const rule = this.table.byRule[ruleId];
    if (rule && rule.total >= this.table.minSamples) {
      return (rule.useful + 1) / (rule.total + 2);
    }
    const src = this.table.bySource[source];
    if (src && src.total >= this.table.minSamples) {
      return (src.useful + 1) / (src.total + 2);
    }
    return undefined;
  }

  /**
   * Blend a pipeline-derived confidence with measured precision. Returns the
   * input unchanged when there is no data for this rule/source.
   */
  adjust(confidence: number, ruleId: string, source: string): number {
    const rel = this.reliability(ruleId, source);
    if (rel === undefined) return confidence;
    const blended = 0.5 * confidence + 0.5 * rel;
    return Math.min(1, Math.max(0, blended));
  }
}
