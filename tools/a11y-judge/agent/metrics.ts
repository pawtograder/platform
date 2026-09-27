/**
 * Agent-run evaluation metrics (a11y-judge v2, Wave 5).
 *
 * Aggregates trajectory + verdict artifacts into the paper's scorecards:
 *  - clean reliability: per-task predicate pass rate, outcome consistency,
 *    steps/turns/cost, tool-sequence variance across samples;
 *  - mutation gauntlet: per (mutation, task) blocked-or-detected rate and
 *    steps delta vs clean, with a WCAG-SC match flag against the mutation's
 *    ground-truth criterion;
 *  - ablation vs the round-1 static judge (detection = blocked-or-reported here
 *    vs judge-fail there).
 *
 * Pure functions are unit-tested; the CLI at the bottom reads run directories.
 */

export interface SampleData {
  cell: string; // "<pageId>__<taskId>"
  pageId: string;
  taskId: string;
  sampleIndex: number;
  outcome: string | null;
  predicateSuccess: boolean;
  isError: boolean;
  salvaged: boolean;
  steps: number;
  turns: number | null;
  costUsd: number | null;
  toolSequence: string[];
  barrierCriteria: string[]; // wcagCriterion of each reported barrier
  mutationId: string | null; // groundTruth planted defect id, or null (clean)
  mutationCriterion: string | null; // WCAG SC the mutation targets
}

export interface TaskReliability {
  cell: string;
  samples: number;
  predicatePassRate: number;
  outcomeConsistency: number; // fraction sharing the modal outcome
  modalOutcome: string;
  meanSteps: number;
  meanTurns: number;
  meanCostUsd: number;
  errorRate: number;
  salvageRate: number;
  meanToolEditDistance: number; // mean pairwise normalized Levenshtein
}

/** Levenshtein over token arrays (tool names). */
export function sequenceEditDistance(a: string[], b: string[]): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Mean pairwise edit distance normalized by the longer sequence length. */
export function meanPairwiseToolVariance(sequences: string[][]): number {
  if (sequences.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sequences.length; i++) {
    for (let j = i + 1; j < sequences.length; j++) {
      const denom = Math.max(sequences[i].length, sequences[j].length, 1);
      total += sequenceEditDistance(sequences[i], sequences[j]) / denom;
      pairs++;
    }
  }
  return pairs ? total / pairs : 0;
}

function mean(xs: number[]): number {
  const vals = xs.filter((x) => Number.isFinite(x));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function modal<T>(xs: T[]): { value: T; count: number } {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T = xs[0];
  let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) (best = value), (bestCount = count);
  return { value: best, count: bestCount };
}

/** Reliability across the samples of one clean (page, task) cell. */
export function taskReliability(samples: SampleData[]): TaskReliability {
  const n = samples.length;
  const outcomes = samples.map((s) => s.outcome ?? "error");
  const { value: modalOutcome, count } = modal(outcomes);
  return {
    cell: samples[0].cell,
    samples: n,
    predicatePassRate: samples.filter((s) => s.predicateSuccess).length / n,
    outcomeConsistency: count / n,
    modalOutcome,
    meanSteps: mean(samples.map((s) => s.steps)),
    meanTurns: mean(samples.map((s) => s.turns ?? NaN)),
    meanCostUsd: mean(samples.map((s) => s.costUsd ?? NaN)),
    errorRate: samples.filter((s) => s.isError).length / n,
    salvageRate: samples.filter((s) => s.salvaged).length / n,
    meanToolEditDistance: meanPairwiseToolVariance(samples.map((s) => s.toolSequence))
  };
}

export interface MutationDetection {
  mutationId: string;
  mutationCriterion: string | null;
  taskId: string;
  samples: number;
  /** Task could not be completed (predicate failed / outcome blocked). */
  blockedRate: number;
  /** A barrier was reported whose WCAG SC matches the planted defect. */
  scMatchRate: number;
  /** blocked OR SC-matched — the agent "noticed" the defect either way. */
  detectionRate: number;
  meanStepsDelta: number; // vs clean baseline mean for the same task
}

/**
 * Detection for one (mutation, task) group. `cleanMeanSteps` is the clean
 * baseline for the same task (for the steps-to-completion delta).
 */
export function mutationDetection(samples: SampleData[], cleanMeanSteps: number): MutationDetection {
  const n = samples.length;
  const criterion = samples[0].mutationCriterion;
  const blocked = samples.map((s) => !s.predicateSuccess || s.outcome === "blocked");
  const scMatch = samples.map(
    (s) => criterion != null && s.barrierCriteria.some((c) => normalizeSc(c) === normalizeSc(criterion))
  );
  return {
    mutationId: samples[0].mutationId ?? "unknown",
    mutationCriterion: criterion,
    taskId: samples[0].taskId,
    samples: n,
    blockedRate: blocked.filter(Boolean).length / n,
    scMatchRate: scMatch.filter(Boolean).length / n,
    detectionRate: blocked.map((b, i) => b || scMatch[i]).filter(Boolean).length / n,
    meanStepsDelta: mean(samples.map((s) => s.steps)) - cleanMeanSteps
  };
}

/** "4.1.2 Name, Role, Value (Level A)" -> "4.1.2"; tolerant compare. */
export function normalizeSc(sc: string): string {
  const m = sc.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : sc.trim().toLowerCase();
}
