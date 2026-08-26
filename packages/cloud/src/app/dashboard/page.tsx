import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth0 } from "@/lib/auth0";
import { hasSuperAdminAccess } from "@/lib/admin";
import { quotaDisplayData } from "@/lib/cloud-quota";
import { dashboardFailureCopy } from "@/lib/private-alpha";
import {
  DashboardDataError,
  loadDashboardData,
  type CloudDevice,
  type CloudDeviceEnrollment,
  type DashboardData,
} from "@/lib/supabase/auth0";
import { AccountLifecycle } from "./account-lifecycle";
import { SignOut } from "./sign-out";
import { Brand } from "../brand";

export const dynamic = "force-dynamic";

interface Viewer {
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

function formatDate(value: string | number) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(typeof value === "number" ? value * 1000 : value));
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function DeviceCard({ device }: { device: CloudDevice }) {
  const revoked = Boolean(device.revoked_at);
  return (
    <article className="device-card">
      <div className="device-icon" aria-hidden="true">
        <span />
      </div>
      <div className="device-details">
        <div className="device-heading">
          <h3>{device.name}</h3>
          <span className={`state-pill ${revoked ? "state-muted" : "state-good"}`}>
            {revoked ? "Revoked" : "Active"}
          </span>
        </div>
        <dl className="device-meta">
          <div><dt>Added</dt><dd>{formatDate(device.created_at)}</dd></div>
          <div><dt>Last seen</dt><dd>{device.last_seen_at ? formatDate(device.last_seen_at) : "Not yet reported"}</dd></div>
          <div><dt>Fingerprint</dt><dd><code>{device.fingerprint.slice(0, 12)}…</code></dd></div>
        </dl>
      </div>
    </article>
  );
}

function EnrollmentCard({ enrollment }: { enrollment: CloudDeviceEnrollment }) {
  return (
    <article className="device-card enrollment-card">
      <div className="device-icon pending-device-icon" aria-hidden="true">
        <span />
      </div>
      <div className="device-details">
        <div className="device-heading">
          <h3>{enrollment.name}</h3>
          <span className="state-pill state-warning">
            {enrollment.status === "approved" ? "Completing approval" : "Pending approval"}
          </span>
        </div>
        <dl className="device-meta">
          <div><dt>Requested</dt><dd>{formatDate(enrollment.created_at)}</dd></div>
          <div><dt>Expires</dt><dd>{formatTimestamp(enrollment.expires_at)}</dd></div>
          <div><dt>Fingerprint</dt><dd><code>{enrollment.fingerprint.slice(0, 12)}…</code></dd></div>
        </dl>
      </div>
    </article>
  );
}

function DashboardNavigation({ viewer, adminAccess }: { viewer: Viewer; adminAccess: boolean }) {
  const initial = (viewer.name ?? viewer.email ?? "S").trim().charAt(0).toUpperCase() || "S";
  return (
    <header className="portal-header">
      <Brand />
      <nav className="section-nav" aria-label="Dashboard sections">
        <a href="#overview">Overview</a>
        <a href="#usage">Usage</a>
        <a href="#account">Account</a>
        <a href="#security">Security</a>
        <a href="#devices">Devices</a>
        {adminAccess && <a href="/admin">Admin</a>}
      </nav>
      <div className="viewer-actions">
        <span className="avatar" aria-hidden="true">{initial}</span>
        <SignOut />
      </div>
    </header>
  );
}

function DashboardLoading({ viewer, adminAccess }: { viewer: Viewer; adminAccess: boolean }) {
  return (
    <main className="portal-shell">
      <DashboardNavigation viewer={viewer} adminAccess={adminAccess} />
      <div className="portal-loading" role="status" aria-live="polite">
        <div className="loading-mark"><span /><span /><span /></div>
        <p>Opening your private development portal…</p>
      </div>
    </main>
  );
}

function ConnectionError({ viewer, error, adminAccess }: { viewer: Viewer; error: DashboardDataError; adminAccess: boolean }) {
  const copy = dashboardFailureCopy(error.code, error.message);
  return (
    <main className="portal-shell">
      <DashboardNavigation viewer={viewer} adminAccess={adminAccess} />
      <section className="portal-content error-layout">
        <div className="error-panel">
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.heading}</h1>
          <p className="lede">{copy.description}</p>
          <div className="error-actions">
            <a className="auth-button inline-button" href="/dashboard">Try again</a>
            <SignOut />
          </div>
          <p className="fine">Diagnostic code: {error.code}. Session uploads remain disabled.</p>
        </div>
        <aside className="boundary-card">
          <span className="boundary-icon" aria-hidden="true">!</span>
          <h2>Secure failure boundary</h2>
          <p>The portal stops before reading account data when identity verification or account claiming fails.</p>
          <ul>
            <li>Auth0 web session is still active</li>
            <li>No elevated database credential is used</li>
            <li>No session content is accepted by this preview</li>
          </ul>
        </aside>
      </section>
    </main>
  );
}

function Portal({ viewer, data, adminAccess }: { viewer: Viewer; data: DashboardData; adminAccess: boolean }) {
  const activeDevices = data.devices.filter((device) => !device.revoked_at).length;
  const accountLabel = data.accountId.slice(0, 8);
  const displayName = viewer.name?.trim() || viewer.email?.split("@")[0] || "there";
  const quota = quotaDisplayData(data.entitlement, data.usage);

  return (
    <main className="portal-shell">
      <DashboardNavigation viewer={viewer} adminAccess={adminAccess} />
      <div className="portal-content">
        <section className="portal-intro" id="overview">
          <div>
            <p className="eyebrow">PRIVATE DEVELOPMENT PREVIEW</p>
            <h1>Good to see you, {displayName}.</h1>
            <p className="lede">Review the identity and devices currently linked to your Sinter account. Session transfer and storage are not enabled here.</p>
          </div>
          <div className="preview-status">
            <span className="status-dot" />
            <div><strong>Account connected</strong><span>Auth0 session · RLS-scoped data</span></div>
          </div>
        </section>

        <section className="metric-grid" aria-label="Account overview">
          <article className="metric-card featured">
            <span className="metric-label">Registered devices</span>
            <strong>{data.devices.length}</strong>
            <p>{activeDevices === 1 ? "1 active registration" : `${activeDevices} active registrations`}{data.enrollments.length > 0 ? ` · ${data.enrollments.length} pending` : ""}</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Session uploads</span>
            <strong className="word-value">Disabled</strong>
            <p>Encryption and deletion gates come first.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Cloud execution</span>
            <strong className="word-value">Unavailable</strong>
            <p>This portal does not run agents or workspaces.</p>
          </article>
        </section>

        <section className="portal-section quota-section" id="usage">
          <div className="section-heading quota-heading">
            <div><p className="section-kicker">PLAN &amp; USAGE</p><h2>{quota.planLabel}</h2></div>
            <div className="quota-state">
              <span className="state-pill state-muted">{quota.statusLabel}</span>
              <span className="state-pill state-muted">Uploads {quota.uploadsLabel}</span>
            </div>
          </div>
          <p className="quota-boundary">Cloud storage and session uploads remain unavailable. These counters describe account metadata only and do not imply sync.</p>
          <div className="quota-grid">
            <article>
              <span className="metric-label">Retained storage</span>
              <strong>{quota.retainedStorageLabel}</strong>
              <dl>
                <div><dt>Reserved</dt><dd>{quota.reservedStorageLabel}</dd></div>
                <div><dt>Plan limit</dt><dd>{quota.storageLimitLabel}</dd></div>
              </dl>
            </article>
            <article>
              <span className="metric-label">Cloud sessions</span>
              <strong>{quota.sessionUsageLabel}</strong>
              <dl>
                <div><dt>Reserved</dt><dd>{quota.reservedSessionLabel}</dd></div>
                <div><dt>Plan limit</dt><dd>{quota.sessionLimitLabel}</dd></div>
              </dl>
            </article>
            <article>
              <span className="metric-label">Safety caps</span>
              <strong>{quota.capsuleSafetyLabel}</strong>
              <dl>
                <div><dt>Per capsule</dt><dd>{quota.capsuleSafetyLabel}</dd></div>
                <div><dt>Devices</dt><dd>{quota.deviceSafetyLabel}</dd></div>
              </dl>
            </article>
          </div>
          <p className="quota-authority">Displayed safety caps are mirrored for clarity; database enforcement remains authoritative.</p>
        </section>

        <div className="portal-grid">
          <section className="portal-section account-section" id="account">
            <div className="section-heading">
              <div><p className="section-kicker">ACCOUNT</p><h2>Your cloud identity</h2></div>
              <span className="state-pill state-good">Connected</span>
            </div>
            <dl className="detail-list">
              <div><dt>Email</dt><dd>{viewer.email ?? data.profile.email ?? "Not shared"}</dd></div>
              <div><dt>Email status</dt><dd>{viewer.emailVerified ? "Verified by Auth0" : "Not reported as verified"}</dd></div>
              <div><dt>Identity provider</dt><dd>Auth0</dd></div>
              <div><dt>Account reference</dt><dd><code>{accountLabel}…</code></dd></div>
              <div><dt>Created</dt><dd>{formatDate(data.profile.created_at)}</dd></div>
              <div><dt>Deletion request</dt><dd>{data.profile.deletion_requested_at ? `Requested ${formatDate(data.profile.deletion_requested_at)}` : "None"}</dd></div>
            </dl>
          </section>

          <section className="portal-section security-section" id="security">
            <div className="section-heading">
              <div><p className="section-kicker">SECURITY</p><h2>Current boundaries</h2></div>
            </div>
            <div className="security-list">
              <div><span className="check" aria-hidden="true">✓</span><div><strong>Provider-signed identity</strong><p>Supabase receives the Auth0 ID token from this server session.</p></div></div>
              <div><span className="check" aria-hidden="true">✓</span><div><strong>Row-level account scope</strong><p>Profile changes and account reads are restricted to the claimed account.</p></div></div>
              <div><span className="lock" aria-hidden="true">—</span><div><strong>Session data remains local</strong><p>Uploads, Storage, and Realtime are intentionally unavailable.</p></div></div>
            </div>
            <p className="token-expiry">Current identity token expires {formatDate(data.tokenExpiresAt)}.</p>
          </section>
        </div>

        <AccountLifecycle
          deletionRequestedAt={data.profile.deletion_requested_at}
          deletionRequestedAtLabel={data.profile.deletion_requested_at
            ? formatTimestamp(data.profile.deletion_requested_at)
            : null}
        />

        <section className="portal-section devices-section" id="devices">
          <div className="section-heading">
            <div><p className="section-kicker">DEVICES</p><h2>Registered endpoints</h2></div>
            <span className="section-count">{data.devices.length} registered · {data.enrollments.length} pending</span>
          </div>
          {data.enrollments.length > 0 && (
            <div className="pending-device-group">
              <p className="device-group-label">Awaiting cryptographic approval</p>
              <div className="device-list">{data.enrollments.map((enrollment) => <EnrollmentCard enrollment={enrollment} key={enrollment.id} />)}</div>
              <p className="device-boundary-note">Approve from an active Sinter CLI device that holds its signing key. The portal does not generate, receive, or store device private keys.</p>
            </div>
          )}
          {data.devices.length > 0 ? (
            <div className="registered-device-group">
              {data.enrollments.length > 0 && <p className="device-group-label">Active and revoked registrations</p>}
              <div className="device-list">{data.devices.map((device) => <DeviceCard device={device} key={device.id} />)}</div>
            </div>
          ) : data.enrollments.length === 0 ? (
            <div className="empty-state">
              <div className="empty-device" aria-hidden="true"><span /></div>
              <h3>No devices registered</h3>
              <p>Register the first device from the Sinter CLI. Browser key generation and manual portal enrollment remain intentionally unavailable.</p>
              <code>sinter devices</code>
            </div>
          ) : null}
        </section>

        <footer className="portal-footer">
          <span>Sinter Cloud development portal</span>
          <span>No real session uploads · No billing · No cloud execution</span>
        </footer>
      </div>
    </main>
  );
}

async function DashboardContent({ viewer, idToken, adminAccess }: { viewer: Viewer; idToken: string; adminAccess: boolean }) {
  try {
    const data = await loadDashboardData(idToken);
    return <Portal viewer={viewer} data={data} adminAccess={adminAccess} />;
  } catch (error) {
    const dashboardError = error instanceof DashboardDataError
      ? error
      : new DashboardDataError("configuration", error instanceof Error ? error.message : "Unexpected data error");
    console.error("Sinter dashboard data boundary", { code: dashboardError.code });
    return <ConnectionError viewer={viewer} error={dashboardError} adminAccess={adminAccess} />;
  }
}

export default async function Dashboard() {
  const session = await auth0.getSession();
  if (!session?.user || !session.tokenSet.idToken) redirect("/auth/login?returnTo=/dashboard");
  const viewer: Viewer = {
    email: typeof session.user.email === "string" ? session.user.email : null,
    emailVerified: session.user.email_verified === true,
    name: typeof session.user.name === "string" ? session.user.name : null,
  };
  const adminAccess = await hasSuperAdminAccess(session.tokenSet.idToken);

  return (
    <Suspense fallback={<DashboardLoading viewer={viewer} adminAccess={adminAccess} />}>
      <DashboardContent viewer={viewer} idToken={session.tokenSet.idToken} adminAccess={adminAccess} />
    </Suspense>
  );
}
