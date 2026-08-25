"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

interface LoginCardProps {
  eyebrow?: string;
  heading?: string;
  description?: string;
  fine?: string;
  redirectPath?: string;
}

export function LoginCard({
  eyebrow = "DEVELOPMENT ACCESS",
  heading = "Open your private library",
  description = "Use a one-time email link. No password is stored by Sinter.",
  fine = "Authentication only. Session upload is intentionally unavailable.",
  redirectPath = "/auth/callback",
}: LoginCardProps = {}) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const supabase = createClient();
      const redirectTo = `${window.location.origin}${redirectPath}`;
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
      <p className="card-label">{eyebrow}</p>
      <h2>{heading}</h2>
      <p>{description}</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email address</label>
        <input id="email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
        <button disabled={busy}>{busy ? "Sending…" : "Send sign-in link"}</button>
      </form>
      {message && <p className="message" role="status">{message}</p>}
      <p className="fine">{fine}</p>
    </aside>
  );
}
