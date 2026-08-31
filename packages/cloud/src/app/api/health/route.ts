import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    schema: "sinter.cloud.health.v1",
    ok: true,
    environment: process.env.VERCEL_ENV ?? "local",
    supabaseConfigured: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    auth0Configured: Boolean(
      process.env.AUTH0_DOMAIN && process.env.AUTH0_CLIENT_ID && process.env.AUTH0_CLIENT_SECRET &&
      process.env.AUTH0_SECRET && process.env.AUTH0_AUDIENCE && process.env.AUTH0_CLI_CLIENT_ID,
    ),
    publicCloudSignupsEnabled: false,
    realUploadsEnabled: process.env.SINTER_REAL_UPLOADS_ENABLED === "true",
  });
}
