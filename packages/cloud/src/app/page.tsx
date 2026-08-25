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
          <span className="status"><i />Private development preview</span>
          <a className="nav-link" href={signedIn ? "/dashboard" : "/auth/login?returnTo=/dashboard"}>
            {signedIn ? "Dashboard" : "Sign in"}
          </a>
        </div>
      </nav>
      <section className="hero">
        <div className="copy">
          <p className="eyebrow">LOCAL-FIRST SESSION CONTINUITY</p>
          <h1>Your context should move when you do.</h1>
          <p className="lede">
            Sinter is building a secure path for coding-agent sessions to continue across your devices. The open-source CLI stays useful on its own.
          </p>
          <div className="availability-note">
            <span className="note-mark" aria-hidden="true">01</span>
            <div><strong>Account foundation available now</strong><p>Sign in and review linked account and device records. Real session uploads are disabled.</p></div>
          </div>
        </div>
        <LoginCard signedIn={signedIn} />
      </section>
      <section className="principle-band" aria-label="Product boundaries">
        <div><span>01</span><strong>Local-first</strong><p>Your local sessions and CLI do not require a cloud account.</p></div>
        <div><span>02</span><strong>Encryption before sync</strong><p>No transcript upload before the cryptography and deletion model is ready.</p></div>
        <div><span>03</span><strong>Explicit movement</strong><p>Future transfer flows must be inspectable and user initiated.</p></div>
      </section>
      <footer className="landing-footer">
        <span>Sinter Cloud</span>
        <span>Development foundation · No real session uploads</span>
      </footer>
    </main>
  );
}
