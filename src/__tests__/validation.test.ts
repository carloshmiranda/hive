import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeValidationScore, checkCEOScoreKillTrigger, checkLearningRateKillTrigger } from '@/lib/validation';
import type { MetricsRow } from '@/lib/validation';

// ─── Arbitraries ───

const metricRowArb = fc.record<MetricsRow>({
  date: fc.integer({ min: Date.parse('2020-01-01'), max: Date.parse('2029-12-31') })
    .map(ts => new Date(ts).toISOString().split('T')[0]),
  page_views: fc.nat({ max: 100_000 }),
  signups: fc.option(fc.nat({ max: 10_000 }), { nil: undefined }),
  waitlist_signups: fc.option(fc.nat({ max: 10_000 }), { nil: undefined }),
  waitlist_total: fc.option(fc.nat({ max: 10_000 }), { nil: undefined }),
  revenue: fc.option(fc.double({ min: 0, max: 100_000, noNaN: true }), { nil: undefined }),
  mrr: fc.option(fc.double({ min: 0, max: 100_000, noNaN: true }), { nil: undefined }),
  customers: fc.option(fc.nat({ max: 10_000 }), { nil: undefined }),
  pricing_cta_clicks: fc.option(fc.nat({ max: 10_000 }), { nil: undefined }),
  pricing_page_views: fc.option(fc.nat({ max: 10_000 }), { nil: undefined }),
  affiliate_clicks: fc.option(fc.nat({ max: 10_000 }), { nil: undefined }),
  affiliate_revenue: fc.option(fc.double({ min: 0, max: 100_000, noNaN: true }), { nil: undefined }),
  churn_rate: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
  cac: fc.option(fc.double({ min: 0, max: 10_000, noNaN: true }), { nil: undefined }),
  ad_spend: fc.option(fc.double({ min: 0, max: 100_000, noNaN: true }), { nil: undefined }),
});

const metricsArb = fc.array(metricRowArb, { minLength: 0, maxLength: 60 });

const businessTypeArb = fc.oneof(
  fc.constant('saas'),
  fc.constant('b2c_saas'),
  fc.constant('b2b_saas'),
  fc.constant('blog'),
  fc.constant('newsletter'),
  fc.constant('affiliate_site'),
  fc.constant('faceless_channel'),
  fc.constant('marketplace'),
  fc.constant(null),
  fc.string(), // unknown types should not crash
);

const createdAtArb = fc.integer({ min: Date.parse('2020-01-01'), max: Date.now() })
  .map(ts => new Date(ts).toISOString());

// ─── Tests ───

describe('computeValidationScore', () => {
  it('always returns score in [0, 100]', () => {
    fc.assert(
      fc.property(businessTypeArb, metricsArb, createdAtArb, (type, metrics, createdAt) => {
        const result = computeValidationScore(type, metrics, createdAt);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }),
      { numRuns: 200 }
    );
  });

  it('always returns revenue_readiness_score in [0, 100]', () => {
    fc.assert(
      fc.property(businessTypeArb, metricsArb, createdAtArb, (type, metrics, createdAt) => {
        const result = computeValidationScore(type, metrics, createdAt);
        expect(result.revenue_readiness_score).toBeGreaterThanOrEqual(0);
        expect(result.revenue_readiness_score).toBeLessThanOrEqual(100);
      }),
      { numRuns: 200 }
    );
  });

  it('kill_signal is never true when latest metric has revenue', () => {
    // Build metrics where the first row (latest) has revenue > 0
    const metricsWithRevenueArb = fc.tuple(metricRowArb, metricsArb).map(([head, tail]) => {
      const latestWithRevenue = { ...head, revenue: 100, mrr: 0 };
      return [latestWithRevenue, ...tail];
    });

    fc.assert(
      fc.property(businessTypeArb, metricsWithRevenueArb, createdAtArb, (type, metrics, createdAt) => {
        const result = computeValidationScore(type, metrics, createdAt);
        // Revenue = infinite patience: kill_signal must be false
        expect(result.kill_signal).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('kill_signal is never true when latest metric has MRR', () => {
    const metricsWithMrrArb = fc.tuple(metricRowArb, metricsArb).map(([head, tail]) => {
      const latestWithMrr = { ...head, revenue: 0, mrr: 50 };
      return [latestWithMrr, ...tail];
    });

    fc.assert(
      fc.property(businessTypeArb, metricsWithMrrArb, createdAtArb, (type, metrics, createdAt) => {
        const result = computeValidationScore(type, metrics, createdAt);
        expect(result.kill_signal).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('always returns a phase string (never empty)', () => {
    fc.assert(
      fc.property(businessTypeArb, metricsArb, createdAtArb, (type, metrics, createdAt) => {
        const result = computeValidationScore(type, metrics, createdAt);
        expect(result.phase).toBeTruthy();
        expect(typeof result.phase).toBe('string');
      }),
      { numRuns: 200 }
    );
  });

  it('phase_index is valid index into phases array', () => {
    fc.assert(
      fc.property(businessTypeArb, metricsArb, createdAtArb, (type, metrics, createdAt) => {
        const result = computeValidationScore(type, metrics, createdAt);
        expect(result.phase_index).toBeGreaterThanOrEqual(0);
        expect(result.phase_index).toBeLessThan(result.phases.length);
        expect(result.phases[result.phase_index]).toBe(result.phase);
      }),
      { numRuns: 200 }
    );
  });

  it('score_breakdown values never go negative', () => {
    fc.assert(
      fc.property(businessTypeArb, metricsArb, createdAtArb, (type, metrics, createdAt) => {
        const result = computeValidationScore(type, metrics, createdAt);
        for (const value of Object.values(result.score_breakdown)) {
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('does not throw on empty metrics array', () => {
    fc.assert(
      fc.property(businessTypeArb, createdAtArb, (type, createdAt) => {
        expect(() => computeValidationScore(type, [], createdAt)).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });

  it('kill_signal for new company (0 days old) is always false regardless of metrics', () => {
    // A company created right now should never immediately trigger a kill signal
    // (all kill thresholds require 60+ days)
    const justCreated = new Date().toISOString();

    fc.assert(
      fc.property(businessTypeArb, metricsArb, (type, metrics) => {
        const result = computeValidationScore(type, metrics, justCreated);
        expect(result.kill_signal).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});

describe('checkCEOScoreKillTrigger', () => {
  it('returns null when fewer than 3 cycles provided', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ cycle_number: fc.nat(), score: fc.double({ min: 0, max: 10, noNaN: true }).map(String) }),
          { minLength: 0, maxLength: 2 }
        ),
        (cycles) => {
          expect(checkCEOScoreKillTrigger(cycles)).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns non-null when last 3 cycles all score <4', () => {
    // The 3 most recent cycles (highest cycle_number) all have score <4
    const lowScore = () => fc.double({ min: 0, max: 3.99, noNaN: true }).map(String);
    const highScore = () => fc.double({ min: 4, max: 10, noNaN: true }).map(String);

    fc.assert(
      fc.property(
        fc.tuple(lowScore(), lowScore(), lowScore()),
        fc.array(
          fc.record({ cycle_number: fc.nat({ max: 2 }), score: highScore() }),
          { minLength: 0, maxLength: 5 }
        ),
        ([s1, s2, s3], olderCycles) => {
          // Recent cycles have numbers 100, 101, 102 (higher than older cycles 0-2)
          const recentCycles = [
            { cycle_number: 100, score: s1 },
            { cycle_number: 101, score: s2 },
            { cycle_number: 102, score: s3 },
          ];
          const allCycles = [...recentCycles, ...olderCycles];
          expect(checkCEOScoreKillTrigger(allCycles)).not.toBeNull();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns null when any of the last 3 cycles scores >= 4', () => {
    fc.assert(
      fc.property(
        // At least one score is >= 4
        fc.tuple(
          fc.double({ min: 4, max: 10, noNaN: true }).map(String),
          fc.double({ min: 0, max: 10, noNaN: true }).map(String),
          fc.double({ min: 0, max: 10, noNaN: true }).map(String),
        ),
        fc.array(
          fc.record({ cycle_number: fc.nat({ max: 2 }), score: fc.constant('5') }),
          { minLength: 0, maxLength: 5 }
        ),
        ([s1, s2, s3], olderCycles) => {
          // Shuffle scores to test different positions
          const recentCycles = [
            { cycle_number: 100, score: s1 }, // guaranteed >= 4
            { cycle_number: 101, score: s2 },
            { cycle_number: 102, score: s3 },
          ];
          const allCycles = [...recentCycles, ...olderCycles];
          expect(checkCEOScoreKillTrigger(allCycles)).toBeNull();
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ─── checkLearningRateKillTrigger tests ───

describe('checkLearningRateKillTrigger', () => {
  it('returns null when fewer than 4 cycles provided', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cycle_number: fc.nat({ max: 100 }),
            score: fc.double({ min: 0, max: 10, noNaN: true }).map(String),
          }),
          { minLength: 0, maxLength: 3 }
        ),
        (cycles) => {
          expect(checkLearningRateKillTrigger(cycles)).toBeNull();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns a trigger message when avg < 6 and range < 1.5 across 4+ cycles', () => {
    // All scores tightly clustered around 4 (avg 4, range 0) — clearly stagnant
    const stagnantCycles = [
      { cycle_number: 1, score: '4.0' },
      { cycle_number: 2, score: '4.1' },
      { cycle_number: 3, score: '3.9' },
      { cycle_number: 4, score: '4.0' },
    ];
    const result = checkLearningRateKillTrigger(stagnantCycles);
    expect(result).not.toBeNull();
    expect(result).toContain('LEARNING RATE STAGNANT');
  });

  it('returns null when avg >= 6 even if range is small', () => {
    fc.assert(
      fc.property(
        // Generate 4+ cycles all with scores between 6 and 7 (avg >= 6, range < 1.5)
        fc.array(
          fc.record({
            cycle_number: fc.nat({ max: 100 }),
            score: fc.double({ min: 6, max: 7, noNaN: true }).map(String),
          }),
          { minLength: 4, maxLength: 8 }
        ),
        (cycles) => {
          expect(checkLearningRateKillTrigger(cycles)).toBeNull();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns null when avg < 6 but range >= 1.5 (improvement signal present)', () => {
    // Scores vary widely (e.g. 2 to 8) — range is large enough to show learning
    const improvingCycles = [
      { cycle_number: 1, score: '2.0' },
      { cycle_number: 2, score: '3.5' },
      { cycle_number: 3, score: '5.0' },
      { cycle_number: 4, score: '7.0' },
    ];
    expect(checkLearningRateKillTrigger(improvingCycles)).toBeNull();
  });

  it('uses only the 6 most recent cycles by cycle_number', () => {
    // Older cycles are bad (stagnant), recent cycles are improving
    const cycles = [
      { cycle_number: 1, score: '3.0' },
      { cycle_number: 2, score: '3.1' },
      { cycle_number: 3, score: '2.9' },
      { cycle_number: 4, score: '3.0' },
      // Recent cycles (used): high variance, so no trigger
      { cycle_number: 10, score: '2.0' },
      { cycle_number: 11, score: '5.0' },
      { cycle_number: 12, score: '3.0' },
      { cycle_number: 13, score: '7.0' },
      { cycle_number: 14, score: '2.0' },
      { cycle_number: 15, score: '6.5' },
    ];
    // The 6 most recent: cycles 10-15 → range ~5 → no trigger
    expect(checkLearningRateKillTrigger(cycles)).toBeNull();
  });
});
