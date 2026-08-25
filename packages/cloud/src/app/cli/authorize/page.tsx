import { Brand } from "@/app/brand";

export const dynamic = "force-dynamic";

export default function CliAuthorize() {
  return (
    <main className="shell authorize">
      <nav className="nav">
        <Brand />
        <span className="status"><i />CLI device login</span>
      </nav>
      <section className="authorize-body">
        <div className="authorize-copy">
          <p className="eyebrow">CONNECT THIS DEVICE</p>
          <h1>Sign in, then return securely to your terminal.</h1>
          <p className="lede">The browser proves who you are. Your short-lived session is returned only to Sinter on this device.</p>
        </div>
        <aside className="card"><p className="card-label">CLI ACCESS</p><h2>Use device authorization</h2><p>Run <code>sinter login</code>. Auth0 will show this page with a short code to approve—no localhost callback is required.</p></aside>
      </section>
    </main>
  );
}
