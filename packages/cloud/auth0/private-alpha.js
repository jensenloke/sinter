const SINTER_CLIENT_IDS = new Set([
  "f31iuEGrPhgKJnIQKvQBA21oCpqBXJzp",
  "OMDOHjF7t59nw32zRv7G4D5vvVe5yutg",
]);

exports.onExecutePostLogin = async (event, api) => {
  if (!SINTER_CLIENT_IDS.has(event.client.client_id)) return;
  if (event.user.app_metadata?.sinter_cloud_access === true) return;
  api.access.deny("sinter_private_alpha");
};
