import { NextResponse } from "next/server";
import { auth0Issuer } from "@/lib/auth0";

export const dynamic = "force-dynamic";

export function GET() {
  const clientId = process.env.AUTH0_CLI_CLIENT_ID;
  const audience = process.env.AUTH0_AUDIENCE;
  if (!clientId || !audience) {
    return NextResponse.json({ ok: false, error: "Device login is unavailable" }, { status: 503 });
  }
  return NextResponse.json({
    schema: "sinter.cloud.auth-config.v1",
    ok: true,
    auth: {
      provider: "auth0",
      issuer: auth0Issuer(),
      clientId,
      audience,
      scope: "openid profile email offline_access",
    },
  }, { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" } });
}
