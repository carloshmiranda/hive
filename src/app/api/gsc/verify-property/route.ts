import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getGSCPropertyList,
  getSiteVerificationToken,
  verifySiteWithGoogle,
  addPropertyToSearchConsole,
} from "@/lib/gsc";

/**
 * POST /api/gsc/verify-property
 *
 * Automates Google Search Console property verification for a Hive company.
 * Auth: CRON_SECRET bearer token.
 *
 * Body: { company_slug: string, step?: "token" | "verify" | "full" }
 *
 * Phase A ("token" or first half of "full"):
 *   1. Look up company → get vercel_url
 *   2. Check if already in GSC → early return if yes
 *   3. Get site verification token from Google
 *   4. Store token in capabilities.gsc_integration.pending_verification_token
 *   5. Create engineering company_task for deploying the meta tag
 *   6. Return { ok: true, step: "token_issued", token, task_created }
 *
 * Phase B ("verify" — called after Engineer deploys the meta tag):
 *   1. Confirm meta tag is live on the site
 *   2. Call Google Site Verification API
 *   3. Add property to Search Console
 *   4. Mark capabilities.gsc_integration.verified = true
 *   5. Auto-expire any pending GSC approvals for this company
 *   6. Return { ok: true, verified, property_added }
 */

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Auth
  const cronSecret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { company_slug?: string; step?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { company_slug, step = "full" } = body;
  if (!company_slug) {
    return NextResponse.json({ error: "company_slug required" }, { status: 400 });
  }

  const sql = getDb();

  // Look up company
  const [company] = await sql`
    SELECT id, slug, name, vercel_url, capabilities, github_repo
    FROM companies
    WHERE slug = ${company_slug}
      AND status NOT IN ('killed', 'idea')
  `;
  if (!company) {
    return NextResponse.json({ error: `Company ${company_slug} not found` }, { status: 404 });
  }

  type CompanyRow = { id: string; slug: string; name: string; vercel_url: string | null; capabilities: unknown; github_repo: string | null };
  const co = company as CompanyRow;

  const siteUrl = co.vercel_url;
  if (!siteUrl) {
    return NextResponse.json(
      { error: `Company ${company_slug} has no vercel_url — cannot verify GSC` },
      { status: 422 }
    );
  }

  // Normalize siteUrl to have trailing slash (GSC requires it)
  const normalizedSiteUrl = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;

  // -----------------------------------------------------------------------
  // Phase B: verify — called after Engineer deploys the meta tag
  // -----------------------------------------------------------------------
  if (step === "verify") {
    return handleVerify(sql, co, normalizedSiteUrl);
  }

  // -----------------------------------------------------------------------
  // Phase A: token — issue verification token and create engineering task
  // -----------------------------------------------------------------------
  // Also the first half of "full" mode
  return handleToken(sql, co, normalizedSiteUrl);
}

// ---------------------------------------------------------------------------
// Phase A implementation
// ---------------------------------------------------------------------------
async function handleToken(
  sql: ReturnType<typeof getDb>,
  company: { id: string; slug: string; name: string; capabilities: unknown; github_repo: string | null },
  siteUrl: string
) {
  // Check if already in GSC
  const existingProperties = await getGSCPropertyList();
  const alreadyVerified = existingProperties.some(
    (p) => p === siteUrl || p === siteUrl.replace(/\/$/, "") || p.replace(/\/$/, "") === siteUrl.replace(/\/$/, "")
  );
  if (alreadyVerified) {
    // Update capabilities to reflect verified state if not already set
    const caps = (company.capabilities as Record<string, unknown>) || {};
    const gscCap = (caps.gsc_integration as Record<string, unknown>) || {};
    if (!gscCap.verified) {
      const merged = {
        ...caps,
        gsc_integration: {
          ...gscCap,
          verified: true,
          verified_at: new Date().toISOString(),
        },
      };
      await sql`
        UPDATE companies
        SET capabilities = ${JSON.stringify(merged)}::jsonb
        WHERE id = ${company.id}
      `;
    }
    return NextResponse.json({ ok: true, already_verified: true, site_url: siteUrl });
  }

  // Get verification token
  const token = await getSiteVerificationToken(siteUrl);
  if (!token) {
    return NextResponse.json(
      { error: "Failed to get site verification token from Google — check GSC service account key setting" },
      { status: 500 }
    );
  }

  // Store token in capabilities
  const caps = (company.capabilities as Record<string, unknown>) || {};
  const gscCap = (caps.gsc_integration as Record<string, unknown>) || {};
  const merged = {
    ...caps,
    gsc_integration: {
      ...gscCap,
      pending_verification_token: token,
      pending_verification_site: siteUrl,
      token_issued_at: new Date().toISOString(),
    },
  };
  await sql`
    UPDATE companies
    SET capabilities = ${JSON.stringify(merged)}::jsonb
    WHERE id = ${company.id}
  `;

  // Create engineering task for deploying the meta tag (dedup by title)
  const taskTitle = "Add Google site verification meta tag";
  const [existingTask] = await sql`
    SELECT id FROM company_tasks
    WHERE company_id = ${company.id}
      AND title ILIKE ${"Add Google site verification%"}
      AND status NOT IN ('done', 'dismissed', 'cancelled')
    LIMIT 1
  `;

  let taskId: string | null = null;
  let taskCreated = false;

  if (!existingTask) {
    const metaTagHtml = `<meta name="google-site-verification" content="${token.replace("google-site-verification=", "")}" />`;
    const taskDesc =
      `Add Google site verification meta tag to the Next.js app so Hive can auto-complete GSC property setup.\n\n` +
      `**Meta tag to add** (place in <head> of app/layout.tsx):\n\`\`\`html\n${metaTagHtml}\n\`\`\`\n\n` +
      `Or using Next.js metadata API in app/layout.tsx:\n\`\`\`typescript\nexport const metadata: Metadata = {\n  verification: { google: "${token.replace("google-site-verification=", "")}" },\n  // ... existing metadata\n};\n\`\`\`\n\n` +
      `**Acceptance criteria:** meta tag present in layout.tsx, deployment green on Vercel.`;

    const [newTask] = await sql`
      INSERT INTO company_tasks (company_id, category, title, description, priority, status, source)
      VALUES (
        ${company.id},
        'engineering',
        ${taskTitle},
        ${taskDesc},
        0,
        'proposed',
        'sentinel'
      )
      RETURNING id
    `;
    taskId = newTask?.id || null;
    taskCreated = true;

    // Sync to GitHub Issue (fire-and-forget)
    if (taskId && company.github_repo) {
      import("@/lib/github-issues").then(({ syncNewCompanyTaskIssue }) =>
        syncNewCompanyTaskIssue(getDb(), taskId!, company.slug, company.github_repo!, {
          title: taskTitle,
          description: taskDesc,
          priority: 0,
          category: "engineering",
          source: "sentinel",
          acceptance: "meta tag present in layout.tsx, deployment green",
        })
      ).catch(() => {});
    }
  } else {
    taskId = existingTask.id;
  }

  console.log(`[gsc/verify-property] Phase A complete for ${company.slug}: token issued, task ${taskCreated ? "created" : "already exists"}`);

  return NextResponse.json({
    ok: true,
    step: "token_issued",
    token,
    site_url: siteUrl,
    task_id: taskId,
    task_created: taskCreated,
  });
}

// ---------------------------------------------------------------------------
// Phase B implementation
// ---------------------------------------------------------------------------
async function handleVerify(
  sql: ReturnType<typeof getDb>,
  company: { id: string; slug: string; name: string; capabilities: unknown },
  siteUrl: string
) {
  const caps = (company.capabilities as Record<string, unknown>) || {};
  const gscCap = (caps.gsc_integration as Record<string, unknown>) || {};
  const pendingToken = gscCap.pending_verification_token as string | undefined;

  if (!pendingToken) {
    return NextResponse.json(
      { error: "No pending_verification_token in capabilities — run step=token first" },
      { status: 422 }
    );
  }

  // Confirm meta tag is live on the site
  let tagLive = false;
  try {
    const siteRes = await fetch(siteUrl, { method: "GET" });
    if (siteRes.ok) {
      const html = await siteRes.text();
      tagLive = html.includes(pendingToken) || html.includes(pendingToken.replace("google-site-verification=", ""));
    }
  } catch {
    // Network error — proceed anyway, Google will confirm
    console.warn(`[gsc/verify-property] Could not fetch ${siteUrl} to check meta tag`);
  }

  // Verify with Google
  const verified = await verifySiteWithGoogle(siteUrl);

  // Add to Search Console
  let propertyAdded = false;
  if (verified) {
    propertyAdded = await addPropertyToSearchConsole(siteUrl);
  }

  // Update capabilities
  const mergedCaps = {
    ...caps,
    gsc_integration: {
      ...gscCap,
      verified,
      verified_at: verified ? new Date().toISOString() : undefined,
      property_added: propertyAdded,
      pending_verification_token: verified ? null : pendingToken,
    },
  };
  await sql`
    UPDATE companies
    SET capabilities = ${JSON.stringify(mergedCaps)}::jsonb
    WHERE id = ${company.id}
  `;

  // Auto-expire pending approvals mentioning GSC/search console for this company
  if (verified) {
    await sql`
      UPDATE approvals
      SET status = 'expired',
          decided_at = NOW(),
          decision_note = 'Auto-expired: GSC property verification completed automatically'
      WHERE company_id = ${company.id}
        AND status = 'pending'
        AND (
          title ILIKE '%google search console%'
          OR title ILIKE '%GSC%'
          OR title ILIKE '%search console%'
          OR description ILIKE '%google search console%'
          OR description ILIKE '%GSC%'
        )
    `.catch(() => {});
  }

  console.log(`[gsc/verify-property] Phase B complete for ${company.slug}: verified=${verified}, property_added=${propertyAdded}, tag_live=${tagLive}`);

  return NextResponse.json({
    ok: true,
    verified,
    property_added: propertyAdded,
    tag_live: tagLive,
    site_url: siteUrl,
  });
}
