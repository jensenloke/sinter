import { createRemoteJWKSet, jwtVerify } from "jose";
import { auth0Issuer } from "./auth0";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(issuer: string) {
  let value = keySets.get(issuer);
  if (!value) {
    value = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
    keySets.set(issuer, value);
  }
  return value;
}

export async function auth0Identity(accessToken: string) {
  const issuer = auth0Issuer();
  const audience = process.env.AUTH0_AUDIENCE;
  if (!audience) throw new Error("Auth0 API audience is not configured");
  const { payload } = await jwtVerify(accessToken, keySet(issuer), {
    issuer,
    audience,
    algorithms: ["RS256"],
  });
  if (!payload.sub) throw new Error("Auth0 token has no subject");

  const response = await fetch(new URL("userinfo", issuer), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Auth0 user profile is unavailable");
  const profile = await response.json() as { sub?: unknown; email?: unknown };
  if (profile.sub !== payload.sub) throw new Error("Auth0 profile did not match token");
  return {
    id: payload.sub,
    email: typeof profile.email === "string" ? profile.email : null,
  };
}
