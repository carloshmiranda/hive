import { NextRequest, NextResponse } from "next/server";
import { migrateRouting, hasRoutingTables } from "@/lib/migrate-routing";
import { requireAuth } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    await requireAuth();

    const alreadyExists = await hasRoutingTables();
    if (alreadyExists) {
      return NextResponse.json({
        ok: true,
        message: "Dynamic routing tables already exist. Migration skipped.",
        already_migrated: true,
      });
    }

    await migrateRouting();

    return NextResponse.json({
      ok: true,
      message: "Dynamic routing migration completed successfully",
      migrated: true,
    });
  } catch (error) {
    console.error("POST /api/routing/migrate error:", error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireAuth();

    const hasRouting = await hasRoutingTables();

    return NextResponse.json({
      ok: true,
      data: {
        migration_needed: !hasRouting,
        has_routing_tables: hasRouting,
      },
    });
  } catch (error) {
    console.error("GET /api/routing/migrate error:", error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}