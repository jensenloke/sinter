import { NextResponse } from "next/server";
import { auth0Identity } from "@/lib/auth0-token";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const user = await auth0Identity(token);
    return NextResponse.json(
      { schema: "sinter.cloud.identity.v1", ok: true, user },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
}
