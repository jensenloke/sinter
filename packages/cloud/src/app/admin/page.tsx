import { notFound, redirect } from "next/navigation";
import { AdminPortalError, loadAdminAccounts, type AdminAccountMetadata } from "@/lib/admin";
import { auth0 } from "@/lib/auth0";
import { formatBytes } from "@/lib/cloud-quota";
import { Brand } from "../brand";
import { SignOut } from "../dashboard/sign-out";
import { EntitlementForm } from "./entitlement-form";

export const dynamic = "force-dynamic";

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function limit(value: number | null, unmetered: boolean, unit: "bytes" | "sessions") {
  if (unmetered) return "Unmetered";
  if (value === null) return "Not configured";
  return unit === "bytes" ? formatBytes(value) : value.toLocaleString("en");
}

function AccountCard({ account }: { account: AdminAccountMetadata }) {
  return (
    <article className="portal-section admin-account-card">
      <div className="section-heading admin-account-heading">
        <div>
          <p className="section-kicker">ACCOUNT METADATA</p>
          <h2>{account.account_email ?? "Email unavailable"}</h2>
          <code>{account.account_id}</code>
        </div>
        <div className="quota-state">
          <span className="state-pill state-muted">{account.plan_code}</span>
          <span className="state-pill state-muted">{account.status}</span>
        </div>
      </div>

      <div className="admin-metadata-grid">
        <dl className="detail-list">
          <div><dt>Created</dt><dd>{formatTimestamp(account.account_created_at)}</dd></div>
          <div><dt>Deletion status</dt><dd>{account.deletion_requested_at ? `Requested ${formatTimestamp(account.deletion_requested_at)}` : "No request"}</dd></div>
          <div><dt>Uploads</dt><dd>Disabled globally</dd></div>
          <div><dt>Entitlement updated</dt><dd>{formatTimestamp(account.updated_at)}</dd></div>
        </dl>
        <dl className="detail-list">
          <div><dt>Retained storage</dt><dd>{formatBytes(account.retained_storage_bytes)}</dd></div>
          <div><dt>Reserved storage</dt><dd>{formatBytes(account.reserved_storage_bytes)}</dd></div>
          <div><dt>Storage limit</dt><dd>{limit(account.storage_limit_bytes, account.unmetered, "bytes")}</dd></div>
          <div><dt>Monthly egress</dt><dd>{formatBytes(account.monthly_egress_bytes)}</dd></div>
        </dl>
        <dl className="detail-list">
          <div><dt>Cloud sessions</dt><dd>{account.capsule_count.toLocaleString("en")}</dd></div>
          <div><dt>Reserved sessions</dt><dd>{account.reserved_capsule_count.toLocaleString("en")}</dd></div>
          <div><dt>Session limit</dt><dd>{limit(account.session_limit, account.unmetered, "sessions")}</dd></div>
          <div><dt>Usage updated</dt><dd>{formatTimestamp(account.usage_updated_at)}</dd></div>
        </dl>
        <dl className="detail-list">
          <div><dt>Per-capsule cap</dt><dd>{formatBytes(account.capsule_size_limit_bytes)}</dd></div>
          <div><dt>Device cap</dt><dd>{account.device_limit.toLocaleString("en")}</dd></div>
          <div><dt>Devices</dt><dd>{account.active_device_count} active / {account.total_device_count} total</dd></div>
          <div><dt>Pending enrollments</dt><dd>{account.pending_enrollment_count.toLocaleString("en")}</dd></div>
        </dl>
      </div>

      <details className="admin-update-panel">
        <summary>Update entitlement metadata</summary>
        <EntitlementForm entitlement={account} />
      </details>
    </article>
  );
}

function AdminUnavailable() {
  return (
    <main className="portal-shell">
      <div className="portal-content error-layout admin-error-layout">
        <section className="error-panel">
          <p className="eyebrow">ADMIN PORTAL UNAVAILABLE</p>
          <h1>Account metadata could not be loaded.</h1>
          <p className="lede">No administrative account details were displayed and no changes were made.</p>
          <a className="auth-button inline-button" href="/dashboard">Return to dashboard</a>
        </section>
      </div>
    </main>
  );
}

export default async function AdminPage() {
  const session = await auth0.getSession();
  if (!session?.user || !session.tokenSet.idToken) redirect("/auth/login?returnTo=/admin");

  let accounts: AdminAccountMetadata[];
  try {
    accounts = await loadAdminAccounts(session.tokenSet.idToken);
  } catch (error) {
    if (!(error instanceof AdminPortalError) || error.code !== "account-list") notFound();
    return <AdminUnavailable />;
  }

  return (
    <main className="portal-shell">
      <header className="portal-header admin-header">
        <Brand />
        <nav className="section-nav" aria-label="Admin sections">
          <a href="/dashboard">Dashboard</a>
          <a href="#accounts">Account metadata</a>
        </nav>
        <div className="viewer-actions"><SignOut /></div>
      </header>
      <div className="portal-content">
        <section className="portal-intro admin-intro">
          <div>
            <p className="eyebrow">SUPER-ADMIN METADATA PORTAL</p>
            <h1>Cloud accounts.</h1>
            <p className="lede">Review account lifecycle, entitlement, usage, and device-count metadata. Session content and cryptographic material are not available here.</p>
          </div>
          <div className="preview-status">
            <span className="status-dot" />
            <div><strong>Authorization rechecked</strong><span>Verified web identity · account-scoped role</span></div>
          </div>
        </section>

        <section id="accounts" className="admin-account-list" aria-label="Cloud account metadata">
          {accounts.length > 0
            ? accounts.map((account) => <AccountCard account={account} key={account.account_id} />)
            : <div className="empty-state"><h2>No account metadata returned</h2><p>The administrative listing RPC returned no rows.</p></div>}
        </section>

        <footer className="portal-footer">
          <span>Sinter Cloud administrative metadata</span>
          <span>No session content · No cryptographic material · Uploads disabled</span>
        </footer>
      </div>
    </main>
  );
}
