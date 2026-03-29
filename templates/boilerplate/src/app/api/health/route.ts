// GET /api/health — basic health check for monitoring and smoke tests
export async function GET() {
  const checks: Record<string, string> = { status: "ok" };

  // Check database connectivity if DATABASE_URL is set
  if (process.env.DATABASE_URL) {
    try {
      const { getDb } = await import("@/lib/db");
      const sql = getDb();
      await sql`SELECT 1`;
      checks.database = "ok";
    } catch {
      checks.database = "error";
      checks.status = "degraded";
    }
  }

  const statusCode = checks.status === "ok" ? 200 : 503;
  return Response.json(checks, { status: statusCode });
}
