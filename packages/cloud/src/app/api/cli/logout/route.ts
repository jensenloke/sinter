import { NextResponse } from "next/server";
import { auth0Issuer } from "@/lib/auth0";
import { auth0Identity } from "@/lib/auth0-token";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const body = await request.json().catch(() => ({})) as { refreshToken?: unknown };
  if (!accessToken || typeof body.refreshToken !== "string") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const clientId = process.env.AUTH0_CLI_CLIENT_ID;
  if (!clientId) return NextResponse.json({ ok: false, error: "Unavailable" }, { status: 503 });
  if (!await auth0Identity(accessToken).catch(() => undefined)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const response = await fetch(new URL("oauth/revoke", auth0Issuer()), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token: body.refreshToken, token_type_hint: "refresh_token" }),
    cache: "no-store",
  });
  if (!response.ok) return NextResponse.json({ ok: false, error: "Could not revoke session" }, { status: 502 });
  return NextResponse.json({ schema: "sinter.cloud.logout.v2", ok: true }, { headers: { "Cache-Control": "private, no-store" } });
}
