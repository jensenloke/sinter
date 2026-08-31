import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { CliTokenVerifier } from "../src/lib/device-auth";

const original = {
  domain: process.env.AUTH0_DOMAIN,
  audience: process.env.AUTH0_AUDIENCE,
  cliClientId: process.env.AUTH0_CLI_CLIENT_ID,
};

const issuer = "https://devices.example.test/";
const apiAudience = "https://api.example.test";
const cliClientId = "native-client-id";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
let verifyCliDeviceRequest: typeof import("../src/lib/device-auth").verifyCliDeviceRequest;

const verifier: CliTokenVerifier = async (token, options) => (await jwtVerify(token, keyPair.publicKey, {
  issuer: options.issuer,
  audience: options.audience,
  algorithms: [...options.algorithms],
})).payload;

async function token(audience: string, subject = "auth0|device-user", identity = false) {
  const builder = new SignJWT(identity ? {
    role: "authenticated",
    email: "verified@example.test",
    email_verified: true,
  } : {})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m");
  return builder.sign(keyPair.privateKey);
}

function request(accessToken: string, idToken: string) {
  return new Request("https://cloud.example.test/api/cli/devices", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Sinter-ID-Token": idToken,
    },
  });
}

beforeAll(async () => {
  process.env.AUTH0_DOMAIN = "devices.example.test";
  process.env.AUTH0_AUDIENCE = apiAudience;
  process.env.AUTH0_CLI_CLIENT_ID = cliClientId;
  ({ verifyCliDeviceRequest } = await import("../src/lib/device-auth"));
});

afterAll(() => {
  for (const [name, value] of [
    ["AUTH0_DOMAIN", original.domain],
    ["AUTH0_AUDIENCE", original.audience],
    ["AUTH0_CLI_CLIENT_ID", original.cliClientId],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("paired CLI Auth0 tokens", () => {
  test("requires a verified matching access-token and ID-token pair", async () => {
    const identity = await verifyCliDeviceRequest(
      request(await token(apiAudience), await token(cliClientId, undefined, true)),
      verifier,
    );
    expect(identity).toEqual({
      issuer,
      subject: "auth0|device-user",
      email: "verified@example.test",
    });
  });

  test("rejects the wrong access-token or ID-token audience", async () => {
    await expect(verifyCliDeviceRequest(
      request(await token("wrong-api"), await token(cliClientId, undefined, true)),
      verifier,
    )).rejects.toMatchObject({ kind: "unauthorized", message: "Unauthorized" });
    await expect(verifyCliDeviceRequest(
      request(await token(apiAudience), await token("wrong-client", undefined, true)),
      verifier,
    )).rejects.toMatchObject({ kind: "unauthorized", message: "Unauthorized" });
  });

  test("rejects mismatched subjects", async () => {
    await expect(verifyCliDeviceRequest(
      request(await token(apiAudience, "auth0|one"), await token(cliClientId, "auth0|two", true)),
      verifier,
    )).rejects.toMatchObject({ kind: "unauthorized" });
  });

  test("requires the authenticated role and verified email on the ID token", async () => {
    const invalidIdentity = await new SignJWT({
      role: "authenticated",
      email: "unverified@example.test",
      email_verified: false,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setSubject("auth0|device-user")
      .setAudience(cliClientId)
      .setExpirationTime("5m")
      .sign(keyPair.privateKey);
    await expect(verifyCliDeviceRequest(
      request(await token(apiAudience), invalidIdentity),
      verifier,
    )).rejects.toMatchObject({ kind: "unauthorized" });
  });

  test("fails closed with a sanitized configuration error when audiences are absent", async () => {
    const previous = process.env.AUTH0_CLI_CLIENT_ID;
    delete process.env.AUTH0_CLI_CLIENT_ID;
    try {
      await expect(verifyCliDeviceRequest(
        request(await token(apiAudience), await token(cliClientId, undefined, true)),
        verifier,
      )).rejects.toMatchObject({
        kind: "configuration",
        message: "Device authentication is unavailable",
      });
    } finally {
      process.env.AUTH0_CLI_CLIENT_ID = previous;
    }
  });
});
