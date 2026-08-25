/**
 * Supabase selects the Postgres role from the ID-token `role` claim.
 * Auth0 access tokens intentionally do not receive this non-namespaced claim.
 */
exports.onExecutePostLogin = async (_event, api) => {
  api.idToken.setCustomClaim("role", "authenticated");
};
