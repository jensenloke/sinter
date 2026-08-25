import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    schema: "sinter.cloud.health.v1",
    ok: true,
    environment: process.env.VERCEL_ENV ?? "local",
    supabaseConfigured: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    realUploadsEnabled: false,
  });
}
