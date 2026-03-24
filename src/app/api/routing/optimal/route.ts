import { NextRequest, NextResponse } from "next/server";
import { getOptimalModel, type Agent } from "@/lib/dynamic-routing";
import { requireAuth } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    await requireAuth();

    const body = await request.json();
    const { agent, context } = body;

    if (!agent) {
      return NextResponse.json(
        { ok: false, error: "Missing required field: agent" },
        { status: 400 }
      );
    }

    const optimalModel = await getOptimalModel(agent as Agent, context || {});

    return NextResponse.json({
      ok: true,
      data: {
        agent,
        optimal_model: optimalModel,
        context: context || {},
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("POST /api/routing/optimal error:", error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}