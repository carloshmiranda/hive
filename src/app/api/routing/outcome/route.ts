import { NextRequest, NextResponse } from "next/server";
import { recordModelOutcome, type Agent, type ModelConfig } from "@/lib/dynamic-routing";
import { requireAuth } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    await requireAuth();

    const body = await request.json();
    const { agent, model_config, success, duration_s, context } = body;

    if (!agent || !model_config || typeof success !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: agent, model_config, success" },
        { status: 400 }
      );
    }

    await recordModelOutcome(
      agent as Agent,
      model_config as ModelConfig,
      success,
      duration_s,
      context || {}
    );

    return NextResponse.json({
      ok: true,
      message: "Model outcome recorded successfully",
    });
  } catch (error) {
    console.error("POST /api/routing/outcome error:", error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}