import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const cliFlow = url.searchParams.get("flow") === "cli";
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(cliFlow ? "/cli/complete" : "/dashboard", url.origin));
  }
  return NextResponse.redirect(new URL(cliFlow ? "/cli/authorize?auth=failed" : "/?auth=failed", url.origin));
}
