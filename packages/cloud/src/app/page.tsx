import { auth0 } from "@/lib/auth0";
import { LoginCard } from "./login-card";
import { Brand } from "./brand";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth0.getSession();
  const signedIn = Boolean(session?.user);

  return (
    <main className="shell landing-shell">
      <nav className="nav landing-nav">
        <Brand />
        <div className="landing-nav-actions">
          <span className="status"><i />Cloud private alpha</span>
          <a className="nav-link" href={signedIn ? "/dashboard" : "/auth/login?returnTo=/dashboard"}>
            {signedIn ? "Dashboard" : "Existing member sign in"}
          </a>
        </div>
      </nav>
      <section className="hero">
        <div className="copy">
          <p className="eyebrow">SINTER CLOUD · PRIVATE ALPHA</p>
          <h1>Your context should move when you do.</h1>
          <p className="lede">
            Sinter Cloud is a private alpha for existing members. The open-source CLI remains local-first, public, and fully useful without a Cloud account.
          </p>
          <div className="availability-note">
            <span className="note-mark" aria-hidden="true">01</span>
            <div><strong>Cloud access is currently closed</strong><p>New Cloud accounts are not being created during the private alpha. Real session uploads remain disabled.</p></div>
          </div>
        </div>
        <LoginCard signedIn={signedIn} />
      </section>
      <section className="principle-band" aria-label="Product boundaries">
        <div><span>01</span><strong>Local-first</strong><p>Your local sessions and CLI do not require a cloud account.</p></div>
        <div><span>02</span><strong>Encryption before sync</strong><p>No transcript upload before the cryptography and deletion model is ready.</p></div>
        <div><span>03</span><strong>Existing members only</strong><p>Cloud sign-in is limited to accounts already admitted to the private alpha.</p></div>
      </section>
      <footer className="landing-footer">
        <span>Sinter Cloud private alpha</span>
        <span>Existing members only · No real session uploads</span>
      </footer>
    </main>
  );
}
