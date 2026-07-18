import { NextResponse } from "next/server";
import { database } from "@/server/database";
export async function GET() {
  try {
    await database().$queryRaw`
      SELECT count(*)::int AS applied_migrations
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
    `;
    return NextResponse.json({ status: "ready", database: "ok" });
  } catch {
    return NextResponse.json(
      { status: "not-ready", database: "unavailable" },
      { status: 503 },
    );
  }
}
