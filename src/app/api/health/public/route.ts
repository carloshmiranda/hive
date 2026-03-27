import { getDb } from "@/lib/db";

export async function GET() {
  try {
    // Basic database connectivity check
    const sql = getDb();
    await sql`SELECT 1 as ok`;

    return Response.json(
      {
        status: "healthy",
        timestamp: new Date().toISOString(),
        service: "hive"
      },
      { status: 200 }
    );
  } catch (e: any) {
    return Response.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        service: "hive",
        error: "Database connection failed"
      },
      { status: 503 }
    );
  }
}