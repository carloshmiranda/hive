import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { analyzePR } from '@/lib/pr-risk-scoring';

// ─── Fetch mock helpers ───

interface MockPR {
  ciPassed?: boolean;
  mergeable?: boolean | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  head?: { ref?: string; sha?: string };
  title?: string;
  body?: string;
}

function makeFetchMock(pr: MockPR, diff: string, files: string[] = []) {
  return vi.fn().mockImplementation((url: string) => {
    const urlStr = String(url);

    // PR diff endpoint — must match before the generic pulls endpoint
    // URL: /pulls/{number}.diff
    if (urlStr.endsWith('.diff')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(diff),
      });
    }

    // PR details endpoint
    if (/\/pulls\/\d+$/.test(urlStr)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          number: 1,
          title: pr.title ?? 'Test PR',
          body: pr.body ?? '',
          additions: pr.additions ?? 10,
          deletions: pr.deletions ?? 5,
          changed_files: pr.changed_files ?? 2,
          mergeable: pr.mergeable === undefined ? true : pr.mergeable,
          head: { ref: 'feature/test', sha: 'abc123', ...(pr.head ?? {}) },
        }),
      });
    }

    // CI status endpoint (check-runs)
    if (urlStr.includes('/check-runs')) {
      const checkRuns = pr.ciPassed === false
        ? [{ conclusion: 'failure', name: 'build', status: 'completed' }]
        : [{ conclusion: 'success', name: 'build', status: 'completed' }];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ check_runs: checkRuns }),
      });
    }

    // PR files endpoint
    if (urlStr.includes('/files')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(files.map(f => ({ filename: f, patch: diff }))),
      });
    }

    return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
  });
}

// ─── Secret pattern samples ───

const SECRET_PATTERNS = [
  'sk_live_abcdefghij1234567890',           // Stripe live key
  'sk_test_abcdefghij1234567890',           // Stripe test key
  'rk_live_abcdefghij1234567890',           // Resend live key
  'ghp_' + 'a'.repeat(36),                 // GitHub PAT (40 chars total)
  '-----BEGIN RSA PRIVATE KEY-----',        // Private key
  'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abc', // Bearer token >20 chars
];

const SAFE_STRINGS = [
  'CRON_SECRET',               // Variable name references are safe
  'GEMINI_API_KEY',            // Variable name references are safe
  'Bearer ${token}',           // Template literal (token is a variable)
  'const apiKey = process.env.STRIPE_KEY', // Reading from env
  'sk_',                       // Too short (< 20 chars)
];

// ─── Tests ───

describe('analyzePR — CI hard gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('always escalates when CI has failed', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ciPassed: false }, ''));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    expect(result.decision).toBe('escalate');
    expect(result.hardGatesPassed).toBe(false);
  });

  it('property: CI failure always forces escalate regardless of diff content', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        async (diff) => {
          vi.stubGlobal('fetch', makeFetchMock({ ciPassed: false }, diff));
          const result = await analyzePR('owner', 'repo', 1, 'token');
          expect(result.decision).toBe('escalate');
          expect(result.hardGatesPassed).toBe(false);
        }
      ),
      { numRuns: 20 } // Keep low — each run makes async calls
    );
  });
});

describe('analyzePR — secrets hard gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(SECRET_PATTERNS)('escalates when diff contains secret: %s', async (secret) => {
    vi.stubGlobal('fetch', makeFetchMock({ ciPassed: true }, `+${secret}`));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    expect(result.decision).toBe('escalate');
    expect(result.hardGatesPassed).toBe(false);
  });

  it.each(SAFE_STRINGS)('does NOT escalate on safe string: %s', async (safe) => {
    vi.stubGlobal('fetch', makeFetchMock(
      { ciPassed: true, additions: 5, deletions: 2, changed_files: 1 },
      `+const x = '${safe}'`,
      ['src/lib/utils.ts']
    ));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    // Safe strings should NOT trigger the secrets hard gate
    expect(result.hardGateIssues.some(i => i.includes('secret'))).toBe(false);
  });

  it('property: diff with secret pattern always causes escalate', async () => {
    // Pick a random secret pattern and embed it in arbitrary surrounding text
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SECRET_PATTERNS),
        fc.string({ maxLength: 50 }),
        fc.string({ maxLength: 50 }),
        async (secret, prefix, suffix) => {
          const diff = `${prefix}+${secret}${suffix}`;
          vi.stubGlobal('fetch', makeFetchMock({ ciPassed: true }, diff));
          const result = await analyzePR('owner', 'repo', 1, 'token');
          expect(result.decision).toBe('escalate');
        }
      ),
      { numRuns: 30 }
    );
  });
});

describe('analyzePR — merge conflict hard gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('escalates when PR has merge conflicts (mergeable: false)', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ciPassed: true, mergeable: false }, ''));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    expect(result.decision).toBe('escalate');
    expect(result.hardGatesPassed).toBe(false);
    expect(result.hardGateIssues.some(i => i.includes('conflict'))).toBe(true);
  });

  it('does not flag conflicts when mergeable: true', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ciPassed: true, mergeable: true }, ''));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    expect(result.hardGateIssues.some(i => i.includes('conflict'))).toBe(false);
  });

  it('does not flag conflicts when mergeable: null (unknown)', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ ciPassed: true, mergeable: null }, ''));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    expect(result.hardGateIssues.some(i => i.includes('conflict'))).toBe(false);
  });
});

describe('analyzePR — destructive migration hard gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('escalates on DROP TABLE without rollback', async () => {
    const diff = '+ALTER TABLE users DROP COLUMN email;';
    vi.stubGlobal('fetch', makeFetchMock({ ciPassed: true }, diff));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    expect(result.decision).toBe('escalate');
  });

  it('does NOT escalate on DROP TABLE when rollback present', async () => {
    const diff = '+DROP TABLE temp; rollback strategy: create table temp...';
    vi.stubGlobal('fetch', makeFetchMock(
      { ciPassed: true, additions: 5, deletions: 2, changed_files: 1 },
      diff,
      ['migrations/001.sql']
    ));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    expect(result.hardGateIssues.some(i => i.includes('Destructive'))).toBe(false);
  });
});

describe('analyzePR — risk score invariants', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('riskScore is always >= 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          additions: fc.nat({ max: 200 }),
          deletions: fc.nat({ max: 200 }),
          changed_files: fc.nat({ max: 8 }),
        }),
        fc.array(fc.string({ maxLength: 30 }), { maxLength: 3 }),
        async (prData, files) => {
          // Content-only files (only .md/.txt) to avoid triggering cost gates
          const contentFiles = files.map(f => `content/${f}.md`);
          vi.stubGlobal('fetch', makeFetchMock(
            { ciPassed: true, ...prData, mergeable: true },
            '# only markdown content',
            contentFiles
          ));
          const result = await analyzePR('owner', 'repo', 1, 'token');
          expect(result.riskScore).toBeGreaterThanOrEqual(0);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('auto_merge requires CI passed + no hard gate issues + no cost impact + riskScore <5', async () => {
    // A minimal safe PR: CI passed, no conflicts, no secrets, small diff, content only
    vi.stubGlobal('fetch', makeFetchMock(
      { ciPassed: true, additions: 5, deletions: 2, changed_files: 1, mergeable: true },
      '# updated readme',
      ['README.md']
    ));
    const result = await analyzePR('owner', 'repo', 1, 'token');
    // Should auto-merge: safe diff, no secrets, no cost, small, CI passed
    expect(result.hardGatesPassed).toBe(true);
    expect(result.decision).toBe('auto_merge');
  });
});
