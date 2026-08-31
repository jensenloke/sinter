import { CLI_DOCS_URL, CLI_INSTALL_URL } from "@/lib/private-alpha";

interface LoginCardProps {
  signedIn?: boolean;
}

export function LoginCard({ signedIn = false }: LoginCardProps = {}) {
  return (
    <aside className="card login-card">
      <div className="card-topline">
        <p className="card-label">{signedIn ? "PRIVATE ALPHA ACCESS" : "OPEN-SOURCE CLI"}</p>
        <span className="preview-chip">{signedIn ? "Member" : "Public"}</span>
      </div>
      <h2>{signedIn ? "Your session is active" : "Start with Sinter locally"}</h2>
      <p>{signedIn
        ? "Continue to your existing-member Cloud dashboard."
        : "Install the public CLI to inspect, move, and resume coding-agent sessions without creating a Cloud account."}</p>
      <a className="auth-button" href={signedIn ? "/dashboard" : CLI_INSTALL_URL}>
        {signedIn ? "Open dashboard" : "Install the CLI"}
        <span aria-hidden="true">→</span>
      </a>
      <div className="auth-boundary">
        <span className="mini-lock" aria-hidden="true" />
        {signedIn ? (
          <p>Cloud remains a private alpha. Session uploads are unavailable.</p>
        ) : (
          <p><a href={CLI_DOCS_URL}>Read the CLI docs</a>. Already admitted to Cloud? <a href="/auth/login?returnTo=/dashboard">Existing member sign in</a>.</p>
        )}
      </div>
    </aside>
  );
}
