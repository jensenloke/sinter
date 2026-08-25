import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { auth0Issuer } from "./auth0";

export interface CliDeviceIdentity {
  issuer: string;
  subject: string;
  email: string;
}

export type CliTokenVerifier = (
  token: string,
  options: { issuer: string; audience: string; algorithms: readonly ["RS256"] },
) => Promise<JWTPayload>;

export class CliAuthenticationError extends Error {
  constructor(
    public readonly kind: "configuration" | "unauthorized",
    public readonly detail: string,
  ) {
    super(kind === "configuration" ? "Device authentication is unavailable" : "Unauthorized");
    this.name = "CliAuthenticationError";
  }
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(issuer: string) {
  let value = keySets.get(issuer);
  if (!value) {
    value = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
    keySets.set(issuer, value);
  }
  return value;
}

const remoteVerifier: CliTokenVerifier = async (token, options) => {
  const { payload } = await jwtVerify(token, keySet(options.issuer), {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: [...options.algorithms],
  });
  return payload;
};

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

export async function verifyCliDeviceRequest(
  request: Request,
  verifier: CliTokenVerifier = remoteVerifier,
): Promise<CliDeviceIdentity> {
  const accessToken = bearerToken(request);
  const idToken = request.headers.get("x-sinter-id-token");
  if (!accessToken || !idToken || accessToken.length > 16_384 || idToken.length > 16_384) {
    throw new CliAuthenticationError("unauthorized", "Both bounded CLI tokens are required");
  }

  let issuer: string;
  try {
    issuer = auth0Issuer();
  } catch {
    throw new CliAuthenticationError("configuration", "AUTH0_DOMAIN is missing or invalid");
  }
  const accessAudience = process.env.AUTH0_AUDIENCE;
  const idAudience = process.env.AUTH0_CLI_CLIENT_ID;
  if (!accessAudience || !idAudience) {
    throw new CliAuthenticationError("configuration", "CLI token audiences are not configured");
  }

  try {
    const [access, identity] = await Promise.all([
      verifier(accessToken, { issuer, audience: accessAudience, algorithms: ["RS256"] }),
      verifier(idToken, { issuer, audience: idAudience, algorithms: ["RS256"] }),
    ]);
    if (
      typeof access.sub !== "string"
      || !access.sub
      || typeof identity.sub !== "string"
      || identity.sub !== access.sub
      || access.iss !== issuer
      || identity.iss !== issuer
      || identity.role !== "authenticated"
      || identity.email_verified !== true
      || typeof identity.email !== "string"
      || !identity.email
    ) {
      throw new Error("CLI token claims did not pair");
    }
    return { issuer, subject: access.sub, email: identity.email };
  } catch {
    throw new CliAuthenticationError("unauthorized", "CLI token verification failed");
  }
}
