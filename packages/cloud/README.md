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

## CLI browser login

`/cli/login` accepts only an explicit `http://127.0.0.1:<port>/callback` plus a
random state value. It stores that flow in a signed, HTTP-only, ten-minute
cookie. After magic-link authentication, `/cli/complete` presents an explicit
button that POSTs the short-lived Supabase session and state to the waiting
loopback process. Tokens never appear in the callback URL.

Set `SINTER_CLI_FLOW_SECRET` in Vercel Production to an independent random
value of at least 32 characters. It signs browser-flow cookies only; do not
reuse `CRON_SECRET` or commit either value. CLI identity, refresh, and logout
routes use the public Supabase client and the user's own token—never an admin
or service-role key.

## Deployment boundary

- Deploy `packages/cloud` as the Vercel project root.
- Apply committed SQL migrations with the Supabase CLI before relying on a new
  schema.
- Keep real upload functionality off until the C2 cryptography, tamper,
  deletion, and quota gates in `docs/sinter-cloud-inventory.md` pass.
- The open-source CLI must remain fully useful without a cloud account.
