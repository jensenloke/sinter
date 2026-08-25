# Sinter Cloud development shell

This private Next.js workspace is the hosted authentication and policy shell
for Sinter Cloud. It does not accept session uploads or execute agents.

## Local verification

From the repository root:

```sh
bun install
bunx supabase start
bunx supabase test db
bun run typecheck:cloud
bun run build:cloud
```

Run `bunx supabase stop` when database work is complete. Linked Supabase state,
Vercel state, build output, and environment files must remain untracked.

The hosted development shell is `https://sinter-cloud.vercel.app`. Its public
Supabase URL and publishable key are provided through Vercel environment
variables. Never add a secret or legacy service-role key to this app unless a
reviewed server-only operation genuinely requires it.

## Free-tier keepalive

Vercel invokes `/api/cron/keepalive` once daily. Vercel supplies the
`Authorization: Bearer <CRON_SECRET>` header, and the route performs one
content-free Supabase database RPC using the publishable key. The RPC returns
only the database timestamp and cannot read or write application rows.

Set `CRON_SECRET` in the Vercel Production environment to a random value of at
least 16 characters. Never commit it. An unauthenticated request must return
HTTP 401. This automation reduces idle-pausing risk on the free tier but is not
an uptime guarantee; production availability still requires a paid plan.

## Auth0 authentication

Auth0 owns web and CLI authentication. Supabase remains the Postgres, RLS,
Storage, and Realtime data plane. Configure two first-party Auth0 applications
in one tenant:

- `Sinter Cloud`: Regular Web Application, callback
  `https://sinter-cloud.vercel.app/auth/callback`;
- `Sinter CLI`: Native Application with Device Code and Refresh Token grants.

The CLI requests configuration from `/api/cli/config`, starts Auth0's OAuth
Device Authorization flow, and prints the user code and verification URL. It
works from SSH/headless machines and never embeds a client secret or opens a
localhost callback. Refresh credentials are rotated and stored in the OS
credential store.

The Auth0 API audience must use RS256 and allow offline access. Deploy
`auth0/post-login.js` on the post-login flow so ID tokens contain the literal
`role: authenticated` claim required by Supabase Third-Party Auth. Configure
the Auth0 tenant in Supabase Authentication > Third-Party Auth before applying
the provider-neutral identity migration.

Required server-only Vercel variables are `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
`AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`, `AUTH0_AUDIENCE`,
`AUTH0_CLI_CLIENT_ID`, and `SUPABASE_SECRET_KEY`. `APP_BASE_URL` is the
production site URL. The Supabase secret is used only by paired-token,
cryptographically verified device APIs and must never reach browser code.
Never commit the web client secret, cookie secret, Supabase secret, refresh
tokens, or management token.

CLI device registration sends paired Auth0 access/ID tokens and public P-256
keys. The first-ever device bootstraps; subsequent devices require a signed,
15-minute approval from an active existing device. Private keys stay in the
CLI credential store. Revocation is irreversible, and the initial design has no
recovery after every device is lost or revoked.

## Metadata control plane

`account_entitlements` and `account_usage` are user-readable through own-row
RLS and never browser-writable. Development accounts start with zero Cloud
storage/sessions and uploads disabled. The `/admin` route cryptographically
verifies the Auth0 web ID token, resolves the provider-neutral account, and uses
server-only RPCs only after `admin_is_super_admin` succeeds.

The first owner is granted once through the service-only
`bootstrap_super_admin(account_id, reason)` RPC. Role grant/revoke remains a
service-only operational action and is intentionally absent from the browser
portal. The owner may be unmetered for product storage/session limits while
per-capsule and device safety caps remain enforced. Admin listings and audit
events contain metadata only; no session content or cryptographic material.

## Deployment boundary

- Deploy `packages/cloud` as the Vercel project root.
- Apply committed SQL migrations with the Supabase CLI before relying on a new
  schema.
- Keep real upload functionality off until the C2 cryptography, tamper,
  deletion, and quota gates in `docs/sinter-cloud-inventory.md` pass.
- The open-source CLI must remain fully useful without a cloud account.
