import { NextRequest, NextResponse } from "next/server";
import { getRoutingStats, resetAgentRouting } from "@/lib/dynamic-routing";
import { requireAuth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireAuth();

    const stats = await getRoutingStats();

    return NextResponse.json({
      ok: true,
      data: stats,
    });
  } catch (error) {
    console.error("GET /api/routing error:", error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth();

    const body = await request.json();
    const { action, agent } = body;

    if (action === "reset" && agent) {
      await resetAgentRouting(agent);
      return NextResponse.json({
        ok: true,
        message: `Reset routing data for agent: ${agent}`,
      });
    }

    return NextResponse.json(
      { ok: false, error: "Invalid action or missing agent" },
      { status: 400 }
    );
  } catch (error) {
    console.error("POST /api/routing error:", error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}