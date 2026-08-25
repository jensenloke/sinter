import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CLI_FLOW_COOKIE, decodeCliFlow } from "@/lib/cli-flow";

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]!);
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const flow = decodeCliFlow(cookieStore.get(CLI_FLOW_COOKIE)?.value);
  if (!flow) return NextResponse.redirect(new URL("/?cli=expired", requestUrl.origin));

  const supabase = await createClient();
  const [{ data: userData }, { data: sessionData }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getSession(),
  ]);
  const user = userData.user;
  const session = sessionData.session;
  if (!user || !session) {
    return NextResponse.redirect(new URL("/cli/authorize?auth=failed", requestUrl.origin));
  }

  const callback = new URL(flow.callback);
  const fields = {
    state: flow.state,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: String(session.expires_at ?? 0),
    email: user.email ?? "",
  };
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Return to Sinter</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0f0e;color:#f4f1e8;font-family:Arial,sans-serif}.card{width:min(440px,calc(100% - 40px));padding:40px;border:1px solid #30332f;border-radius:20px;background:#171918;box-shadow:0 28px 90px #0008}.mark{width:52px;height:52px;object-fit:contain}h1{font-size:34px;letter-spacing:-.04em;margin:24px 0 12px}p{color:#a7a8a1;line-height:1.55}button{width:100%;margin-top:18px;padding:15px;border:0;border-radius:10px;background:#c8f560;color:#10120f;font-weight:800;cursor:pointer}.fine{font-size:12px;color:#72756f}</style></head><body><main class="card"><img class="mark" src="/brand/sinter-mark-192.png" alt=""><h1>Finish in your terminal</h1><p>Your identity is verified. Return this short-lived session only to the Sinter process waiting on this device.</p><form action="${escapeHtml(flow.callback)}" method="post">${inputs}<button type="submit">Return to Sinter</button></form><p class="fine">The local callback expires when the CLI command completes.</p></main></body></html>`;
  const response = new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${callback.origin}; base-uri 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
  response.cookies.set(CLI_FLOW_COOKIE, "", { maxAge: 0, path: "/", httpOnly: true, secure: requestUrl.protocol === "https:", sameSite: "lax" });
  return response;
}
