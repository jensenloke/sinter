"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginCard() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const supabase = createClient();
      const redirectTo = `${window.location.origin}/auth/callback`;
      const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
      if (error) throw error;
      setMessage("Check your email for a one-time sign-in link.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in could not be started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="card">
      <p className="card-label">DEVELOPMENT ACCESS</p>
      <h2>Open your private library</h2>
      <p>Use a one-time email link. No password is stored by Sinter.</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email address</label>
        <input id="email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        <button disabled={busy}>{busy ? "Sending…" : "Send sign-in link"}</button>
      </form>
      {message && <p className="message" role="status">{message}</p>}
      <p className="fine">Authentication only. Session upload is intentionally unavailable.</p>
    </aside>
  );
}
