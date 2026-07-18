import { NextResponse } from "next/server";
import { database } from "@/server/database";
export async function GET() {
  try {
    await database().$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ready", database: "ok" });
  } catch {
    return NextResponse.json(
      { status: "not-ready", database: "unavailable" },
      { status: 503 },
    );
  }
}
