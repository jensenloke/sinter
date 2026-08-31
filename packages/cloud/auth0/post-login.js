const SINTER_CLIENT_IDS = new Set([
  "f31iuEGrPhgKJnIQKvQBA21oCpqBXJzp",
  "OMDOHjF7t59nw32zRv7G4D5vvVe5yutg",
]);

/** Supabase selects its Postgres role from Sinter ID tokens only. */
exports.onExecutePostLogin = async (event, api) => {
  if (!SINTER_CLIENT_IDS.has(event.client.client_id)) return;
  api.idToken.setCustomClaim("role", "authenticated");
};
