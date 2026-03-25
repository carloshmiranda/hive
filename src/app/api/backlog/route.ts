import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getSettingValue } from "@/lib/settings";

// GET /api/backlog — list Hive self-improvement backlog items
export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // ready, dispatched, done, all
  const priority = searchParams.get("priority"); // P0, P1, P2, P3

  const sql = getDb();
  let items;

  if (status === "all") {
    items = await sql`
      SELECT * FROM hive_backlog
      ${priority ? sql`WHERE priority = ${priority}` : sql``}
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 100
    `;
  } else {
    const filterStatus = status || "ready";
    items = await sql`
      SELECT * FROM hive_backlog
      WHERE status = ${filterStatus}
      ${priority ? sql`AND priority = ${priority}` : sql``}
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 100
    `;
  }

  return json(items);
}

// POST /api/backlog — add a new backlog item
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { priority, title, description, category, source, theme } = body;

  if (!title || !description) {
    return err("title and description are required");
  }

  const sql = getDb();

  // Dedup: don't create if a similar item already exists (ready/approved/dispatched/in_progress)
  const [existing] = await sql`
    SELECT id, title, status FROM hive_backlog
    WHERE status IN ('ready', 'approved', 'dispatched', 'in_progress')
    AND title ILIKE ${title.slice(0, 50) + "%"}
    LIMIT 1
  `;
  if (existing) {
    return json({ duplicate: true, existing_id: existing.id, existing_status: existing.status }, 409);
  }

  const [item] = await sql`
    INSERT INTO hive_backlog (priority, title, description, category, source, theme)
    VALUES (
      ${priority || "P2"},
      ${title},
      ${description},
      ${category || "feature"},
      ${source || "brainstorm"},
      ${theme || null}
    )
    RETURNING *
  `;

  return json(item, 201);
}

// PATCH /api/backlog — dispatch a specific backlog item or next ready item to hive-engineer.yml
export async function PATCH(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const itemId = searchParams.get("id"); // specific item to dispatch
  const action = searchParams.get("action"); // "dispatch"

  if (action !== "dispatch") {
    return err("action=dispatch is required");
  }

  const sql = getDb();
  let targetItem;

  if (itemId) {
    // Dispatch specific item
    const [item] = await sql`
      SELECT * FROM hive_backlog
      WHERE id = ${itemId} AND status IN ('ready', 'approved')
      LIMIT 1
    `;
    targetItem = item;
  } else {
    // Dispatch next ready item (all priorities)
    const [item] = await sql`
      SELECT * FROM hive_backlog
      WHERE status IN ('ready', 'approved')
      AND NOT (
        notes ILIKE '%[attempt %]%'
        AND dispatched_at IS NOT NULL
        AND dispatched_at > NOW() - INTERVAL '30 minutes'
      )
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 1
    `;
    targetItem = item;
  }

  if (!targetItem) {
    return err("No dispatchable item found");
  }

  // Get GitHub token for dispatch
  const ghToken = await getSettingValue("github_token").catch(() => null);
  if (!ghToken) {
    return err("GitHub token not configured");
  }

  // Check for previous failures and add context
  const attemptMatch = (targetItem.notes || "").match(/\[attempt \d+\]/g);
  const attemptCount = attemptMatch?.length || 0;
  let taskDescription = targetItem.description;

  if (attemptCount > 0) {
    const failures = await sql`
      SELECT error, description, finished_at
      FROM agent_actions
      WHERE agent = 'engineer' AND status = 'failed'
      AND company_id IS NULL
      AND finished_at > NOW() - INTERVAL '7 days'
      AND (description ILIKE ${"%" + targetItem.title.slice(0, 30) + "%"}
           OR output::text ILIKE ${"%" + (targetItem.id || "") + "%"})
      ORDER BY finished_at DESC
      LIMIT 3
    `.catch(() => []);

    if (failures.length > 0) {
      const previousErrors = failures
        .map((f, i) => `Attempt ${i + 1}: ${(f.error || f.description || "unknown error").slice(0, 300)}`)
        .join("\n");
      taskDescription += `\n\n⚠️ PREVIOUS ATTEMPTS FAILED (attempt ${attemptCount + 1}):\n${previousErrors}\n\nDo NOT repeat the same approach. Analyze why it failed and try a different strategy.`;
    }
  }

  // Dispatch to GitHub Actions
  const res = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
    method: "POST",
    headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" },
    body: JSON.stringify({
      event_type: "feature_request",
      client_payload: {
        source: "manual_dispatch",
        company: "_hive",
        task: taskDescription,
        backlog_id: targetItem.id,
        priority: targetItem.priority,
        attempt: attemptCount + 1,
        chain_next: false, // Manual dispatch - don't auto-chain
        spec: targetItem.spec || undefined,
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (res.ok || res.status === 204) {
    // Mark as dispatched
    await sql`
      UPDATE hive_backlog
      SET status = 'dispatched', dispatched_at = NOW()
      WHERE id = ${targetItem.id}
    `.catch(() => {});

    return json({
      dispatched: true,
      item: {
        id: targetItem.id,
        title: targetItem.title,
        priority: targetItem.priority,
        attempt: attemptCount + 1
      }
    });
  }

  return err("GitHub dispatch failed", res.status);
}
