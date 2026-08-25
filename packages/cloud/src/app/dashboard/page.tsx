import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOut } from "./sign-out";
import { Brand } from "../brand";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { data: devices } = await supabase
    .from("devices")
    .select("id,name,created_at,last_seen_at,revoked_at")
    .order("created_at", { ascending: false });

  return (
    <main className="shell dashboard">
      <nav className="nav"><Brand /><SignOut /></nav>
      <section className="panel">
        <p className="eyebrow">PRIVATE DEVELOPMENT PREVIEW</p>
        <h1>Your devices</h1>
        <p className="lede">Signed in as {user.email}. Device enrollment arrives before encrypted capsule sync.</p>
        <div className="empty">
          <span>{devices?.length ?? 0}</span>
          <strong>registered devices</strong>
          <p>Real session uploads are disabled while the encryption and deletion gates are under review.</p>
        </div>
      </section>
    </main>
  );
}
