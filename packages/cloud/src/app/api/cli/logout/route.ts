import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const body = await request.json().catch(() => ({})) as { refreshToken?: unknown };
  if (!accessToken || typeof body.refreshToken !== "string") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Unavailable" }, { status: 503 });
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: sessionError } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: body.refreshToken });
  if (sessionError) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) return NextResponse.json({ ok: false, error: "Could not revoke session" }, { status: 502 });
  return NextResponse.json({ schema: "sinter.cloud.logout.v1", ok: true }, { headers: { "Cache-Control": "private, no-store" } });
}
