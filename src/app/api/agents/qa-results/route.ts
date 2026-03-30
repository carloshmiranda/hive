import { NextRequest, NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { validateOIDC } from '@/lib/oidc';

const sql = neon(process.env.DATABASE_URL!);

interface QAResult {
  company_slug: string;
  test_suite: 'webapp-qa' | 'smoke' | 'custom';
  test_name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  error_message?: string;
  screenshot_path?: string;
  console_logs?: string[];
  browser_logs?: string[];
  metadata?: Record<string, any>;
}

interface QAResultsSubmission {
  company_slug: string;
  deployment_url: string;
  workflow_run_id?: string;
  commit_sha?: string;
  branch?: string;
  pr_number?: number;
  results: QAResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration_ms: number;
  };
}

// POST /api/agents/qa-results - Submit QA test results
export async function POST(request: NextRequest) {
  try {
    // Validate GitHub OIDC token (only workflows can submit results)
    const validatedUser = await validateOIDC(request);
    if (validatedUser instanceof Response) {
      return validatedUser;
    }

    const payload: QAResultsSubmission = await request.json();
    const { company_slug, deployment_url, results, summary, workflow_run_id, commit_sha, branch, pr_number } = payload;

    // Validate required fields
    if (!company_slug || !deployment_url || !results || !summary) {
      return NextResponse.json(
        { error: 'Missing required fields: company_slug, deployment_url, results, summary' },
        { status: 400 }
      );
    }

    // Get company ID
    const companyResult = await sql`
      SELECT id FROM companies WHERE slug = ${company_slug}
    `;

    if (companyResult.length === 0) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    const companyId = companyResult[0].id;

    // Insert QA run record
    const qaRunResult = await sql`
      INSERT INTO qa_runs (
        company_id,
        deployment_url,
        workflow_run_id,
        commit_sha,
        branch,
        pr_number,
        status,
        total_tests,
        passed_tests,
        failed_tests,
        skipped_tests,
        duration_ms,
        started_at,
        finished_at
      ) VALUES (
        ${companyId},
        ${deployment_url},
        ${workflow_run_id || null},
        ${commit_sha || null},
        ${branch || null},
        ${pr_number || null},
        ${summary.failed > 0 ? 'failed' : 'passed'},
        ${summary.total},
        ${summary.passed},
        ${summary.failed},
        ${summary.skipped},
        ${summary.duration_ms},
        NOW(),
        NOW()
      ) RETURNING id
    `;

    const qaRunId = qaRunResult[0].id;

    // Insert individual test results
    for (const result of results) {
      await sql`
        INSERT INTO qa_test_results (
          qa_run_id,
          test_suite,
          test_name,
          status,
          duration_ms,
          error_message,
          screenshot_path,
          console_logs,
          browser_logs,
          metadata
        ) VALUES (
          ${qaRunId},
          ${result.test_suite},
          ${result.test_name},
          ${result.status},
          ${result.duration_ms || null},
          ${result.error_message || null},
          ${result.screenshot_path || null},
          ${result.console_logs ? JSON.stringify(result.console_logs) : null},
          ${result.browser_logs ? JSON.stringify(result.browser_logs) : null},
          ${result.metadata ? JSON.stringify(result.metadata) : null}
        )
      `;
    }

    // If there are failures, create an escalation
    if (summary.failed > 0) {
      const errorDetails = results
        .filter(r => r.status === 'failed')
        .map(r => `${r.test_name}: ${r.error_message || 'Unknown error'}`)
        .join('\n');

      await sql`
        INSERT INTO agent_actions (
          company_id,
          agent,
          action_type,
          status,
          description,
          input,
          started_at,
          finished_at
        ) VALUES (
          ${companyId},
          'engineer',
          'qa_failure',
          'escalated',
          'QA tests failed after deploy',
          ${JSON.stringify({
            qa_run_id: qaRunId,
            failed_tests: summary.failed,
            deployment_url,
            error_details: errorDetails,
            workflow_run_id,
            pr_number
          })},
          NOW(),
          NOW()
        )
      `;
    }

    return NextResponse.json({
      ok: true,
      data: {
        qa_run_id: qaRunId,
        status: summary.failed > 0 ? 'failed' : 'passed',
        total_tests: summary.total,
        failed_tests: summary.failed,
        escalation_created: summary.failed > 0
      }
    });

  } catch (error) {
    console.error('Error submitting QA results:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET /api/agents/qa-results?company_slug=<slug>&limit=10 - Get QA results for a company
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const companySlug = searchParams.get('company_slug');
    const limit = parseInt(searchParams.get('limit') || '10');
    const qaRunId = searchParams.get('qa_run_id');

    if (!companySlug) {
      return NextResponse.json(
        { error: 'company_slug parameter is required' },
        { status: 400 }
      );
    }

    // Get company ID
    const companyResult = await sql`
      SELECT id FROM companies WHERE slug = ${companySlug}
    `;

    if (companyResult.length === 0) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    const companyId = companyResult[0].id;

    if (qaRunId) {
      // Get specific QA run with detailed results
      const qaRun = await sql`
        SELECT
          qr.*,
          ARRAY_AGG(
            JSON_BUILD_OBJECT(
              'id', qtr.id,
              'test_suite', qtr.test_suite,
              'test_name', qtr.test_name,
              'status', qtr.status,
              'duration_ms', qtr.duration_ms,
              'error_message', qtr.error_message,
              'screenshot_path', qtr.screenshot_path,
              'console_logs', qtr.console_logs,
              'browser_logs', qtr.browser_logs,
              'metadata', qtr.metadata
            )
          ) as test_results
        FROM qa_runs qr
        LEFT JOIN qa_test_results qtr ON qr.id = qtr.qa_run_id
        WHERE qr.id = ${qaRunId} AND qr.company_id = ${companyId}
        GROUP BY qr.id
      `;

      return NextResponse.json({
        ok: true,
        data: qaRun[0] || null
      });
    } else {
      // Get recent QA runs (summary only)
      const qaRuns = await sql`
        SELECT
          id,
          deployment_url,
          workflow_run_id,
          commit_sha,
          branch,
          pr_number,
          status,
          total_tests,
          passed_tests,
          failed_tests,
          skipped_tests,
          duration_ms,
          started_at,
          finished_at
        FROM qa_runs
        WHERE company_id = ${companyId}
        ORDER BY started_at DESC
        LIMIT ${limit}
      `;

      return NextResponse.json({
        ok: true,
        data: qaRuns
      });
    }

  } catch (error) {
    console.error('Error retrieving QA results:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}