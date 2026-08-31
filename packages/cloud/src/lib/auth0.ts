import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { handleAuth0Callback } from "./auth-callback";

export const auth0 = new Auth0Client({
  authorizationParameters: {
    audience: process.env.AUTH0_AUDIENCE,
    scope: "openid profile email offline_access",
  },
  enableAccessTokenEndpoint: false,
  onCallback: handleAuth0Callback,
  signInReturnToPath: "/dashboard",
});

export function auth0Issuer() {
  const value = process.env.AUTH0_DOMAIN;
  if (!value) throw new Error("Auth0 is not configured");
  const domain = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) throw new Error("Auth0 domain is invalid");
  return `https://${domain}/`;
}
