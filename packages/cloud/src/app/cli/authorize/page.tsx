import { LoginCard } from "@/app/login-card";
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
        <LoginCard
          eyebrow="CLI ACCESS"
          heading="Continue with email"
          description="We’ll send a one-time link, then connect the waiting Sinter command."
          fine="The callback is limited to 127.0.0.1 and expires after ten minutes."
          redirectPath="/auth/callback?flow=cli"
        />
      </section>
    </main>
  );
}
