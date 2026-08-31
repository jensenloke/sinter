import type { Metadata } from "next";
import { Brand } from "@/app/brand";
import { CLI_DOCS_URL, CLI_INSTALL_URL } from "@/lib/private-alpha";

export const metadata: Metadata = {
  title: "Cloud access unavailable — Sinter",
  description: "Sinter Cloud private alpha access is limited to existing members.",
};

export default function AccessDenied() {
  return (
    <main className="shell authorize">
      <nav className="nav">
        <Brand />
        <span className="status"><i />Cloud private alpha</span>
      </nav>
      <section className="authorize-body">
        <div className="authorize-copy">
          <p className="eyebrow">EXISTING MEMBERS ONLY</p>
          <h1>Sinter Cloud access is not available.</h1>
          <p className="lede">Cloud is in private alpha and is limited to existing members. No Cloud account was created.</p>
        </div>
        <aside className="card">
          <p className="card-label">LOCAL-FIRST</p>
          <h2>The Sinter CLI still works</h2>
          <p>Your local sessions, ports, and direct transfers do not require a Cloud account.</p>
          <a className="auth-button" href={CLI_INSTALL_URL}>
            Install the CLI
            <span aria-hidden="true">→</span>
          </a>
          <div className="auth-boundary">
            <span className="mini-lock" aria-hidden="true" />
            <p><a href={CLI_DOCS_URL}>Read the CLI docs</a> or <a href="/">return to Sinter Cloud</a>.</p>
          </div>
        </aside>
      </section>
    </main>
  );
}
