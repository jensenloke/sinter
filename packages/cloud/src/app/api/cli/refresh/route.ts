import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) return NextResponse.json({ ok: false, error: "Request too large" }, { status: 413 });
  const body = await request.json().catch(() => ({})) as { refreshToken?: unknown };
  if (typeof body.refreshToken !== "string" || body.refreshToken.length > 8192) {
    return NextResponse.json({ ok: false, error: "Invalid refresh token" }, { status: 400 });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Unavailable" }, { status: 503 });
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: body.refreshToken });
  if (error || !data.session || !data.user) {
    return NextResponse.json({ ok: false, error: "Session expired" }, { status: 401 });
  }
  return NextResponse.json({
    schema: "sinter.cloud.session.v1",
    ok: true,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email ?? null },
  }, { headers: { "Cache-Control": "private, no-store" } });
}
