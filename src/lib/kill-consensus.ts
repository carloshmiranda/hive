// Multi-signal kill consensus engine
// Replaces single-agent judgment with weighted voting across 5 business signals.
// Inspired by Raft/Byzantine consensus: quorum required before any kill action fires.

export interface KillSignal {
  name: string;
  weight: number; // 0-1, must sum to 1 across all signals
  value: number;  // 0-1, where 1 = "strong kill signal"
  reason?: string;
}

export interface KillConsensusResult {
  weighted_score: number; // 0-100
  quorum_met: boolean;
  recommendation: "continue" | "kill_evaluate" | "kill";
  signals_fired: string[]; // names of signals with value > 0
}

/**
 * Compute weighted kill consensus from an array of named signals.
 *
 * Quorum rules:
 *   weighted_score >= 75 → kill
 *   weighted_score >= 40 → kill_evaluate
 *   otherwise           → continue
 *
 * Score formula: sum(weight_i * value_i) / sum(weight_i) * 100
 */
export function computeKillConsensus(signals: KillSignal[]): KillConsensusResult {
  if (signals.length === 0) {
    return {
      weighted_score: 0,
      quorum_met: false,
      recommendation: "continue",
      signals_fired: [],
    };
  }

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) {
    return {
      weighted_score: 0,
      quorum_met: false,
      recommendation: "continue",
      signals_fired: [],
    };
  }

  const weightedSum = signals.reduce((sum, s) => sum + s.weight * s.value, 0);
  const weighted_score = Math.round((weightedSum / totalWeight) * 100);

  const signals_fired = signals
    .filter(s => s.value > 0)
    .map(s => s.reason ? `${s.name}: ${s.reason}` : s.name);

  let recommendation: KillConsensusResult["recommendation"];
  let quorum_met: boolean;

  if (weighted_score >= 75) {
    recommendation = "kill";
    quorum_met = true;
  } else if (weighted_score >= 40) {
    recommendation = "kill_evaluate";
    quorum_met = true;
  } else {
    recommendation = "continue";
    quorum_met = false;
  }

  return { weighted_score, quorum_met, recommendation, signals_fired };
}
