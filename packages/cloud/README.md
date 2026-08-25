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

## Deployment boundary

- Deploy `packages/cloud` as the Vercel project root.
- Apply committed SQL migrations with the Supabase CLI before relying on a new
  schema.
- Keep real upload functionality off until the C2 cryptography, tamper,
  deletion, and quota gates in `docs/sinter-cloud-inventory.md` pass.
- The open-source CLI must remain fully useful without a cloud account.
