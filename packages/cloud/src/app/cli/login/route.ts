import { NextResponse } from "next/server";
import { CLI_FLOW_COOKIE, encodeCliFlow, validateLoopbackCallback } from "@/lib/cli-flow";

export function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const callbackValue = url.searchParams.get("callback") ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
    return NextResponse.json({ ok: false, error: "Invalid CLI login state" }, { status: 400 });
  }

  try {
    const callback = validateLoopbackCallback(callbackValue);
    const response = NextResponse.redirect(new URL("/cli/authorize", url.origin));
    response.cookies.set(
      CLI_FLOW_COOKIE,
      encodeCliFlow({ callback, state, createdAt: Date.now() }),
      { httpOnly: true, secure: url.protocol === "https:", sameSite: "lax", maxAge: 10 * 60, path: "/" },
    );
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid CLI callback" },
      { status: 400 },
    );
  }
}
