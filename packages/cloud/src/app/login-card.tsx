interface LoginCardProps {
  eyebrow?: string;
  heading?: string;
  description?: string;
  fine?: string;
  signedIn?: boolean;
}

export function LoginCard({
  eyebrow = "DEVELOPMENT ACCESS",
  heading = "Open your account portal",
  description = "Use Auth0 to review the identity and devices linked to your Sinter account.",
  fine = "Account preview only. Session upload is intentionally unavailable.",
  signedIn = false,
}: LoginCardProps = {}) {
  return (
    <aside className="card login-card">
      <div className="card-topline">
        <p className="card-label">{eyebrow}</p>
        <span className="preview-chip">Preview</span>
      </div>
      <h2>{signedIn ? "Your session is active" : heading}</h2>
      <p>{signedIn ? "Continue to your private development dashboard." : description}</p>
      <a className="auth-button" href={signedIn ? "/dashboard" : "/auth/login?returnTo=/dashboard"}>
        {signedIn ? "Open dashboard" : "Continue securely"}
        <span aria-hidden="true">→</span>
      </a>
      <div className="auth-boundary">
        <span className="mini-lock" aria-hidden="true" />
        <p>{fine}</p>
      </div>
    </aside>
  );
}
