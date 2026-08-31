import { NextResponse } from "next/server";
import { auth0Issuer } from "@/lib/auth0";
import { auth0Identity } from "@/lib/auth0-token";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) return NextResponse.json({ ok: false, error: "Request too large" }, { status: 413 });
  const body = await request.json().catch(() => ({})) as { refreshToken?: unknown };
  if (typeof body.refreshToken !== "string" || body.refreshToken.length > 8192) {
    return NextResponse.json({ ok: false, error: "Invalid refresh token" }, { status: 400 });
  }
  const clientId = process.env.AUTH0_CLI_CLIENT_ID;
  if (!clientId) return NextResponse.json({ ok: false, error: "Unavailable" }, { status: 503 });
  const response = await fetch(new URL("oauth/token", auth0Issuer()), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: body.refreshToken }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    return NextResponse.json({ ok: false, error: "Session expired" }, { status: 401 });
  }
  const user = await auth0Identity(data.access_token).catch(() => undefined);
  if (!user) return NextResponse.json({ ok: false, error: "Session expired" }, { status: 401 });
  return NextResponse.json({
    schema: "sinter.cloud.session.v2",
    ok: true,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : body.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    user,
  }, { headers: { "Cache-Control": "private, no-store" } });
}
