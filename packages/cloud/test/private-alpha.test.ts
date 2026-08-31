import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorizationError, OAuth2Error } from "@auth0/nextjs-auth0/errors";
import AccessDenied from "../src/app/access-denied/page";
import { GET as health } from "../src/app/api/health/route";
import { LoginCard } from "../src/app/login-card";
import { handleAuth0Callback, isAccessDeniedCallback } from "../src/lib/auth-callback";
import { CLI_DOCS_URL, CLI_INSTALL_URL } from "../src/lib/private-alpha";

const privateAlpha = require("../auth0/private-alpha.js") as {
  onExecutePostLogin(event: unknown, api: unknown): Promise<void>;
};
const roleClaim = require("../auth0/post-login.js") as {
  onExecutePostLogin(event: unknown, api: unknown): Promise<void>;
};
const SINTER_WEB_CLIENT_ID = "f31iuEGrPhgKJnIQKvQBA21oCpqBXJzp";

function auth0Api() {
  const denied: string[] = [];
  const claims: Array<[string, unknown]> = [];
  return {
    denied,
    claims,
    api: {
      access: { deny: (reason: string) => denied.push(reason) },
      idToken: { setCustomClaim: (name: string, value: unknown) => claims.push([name, value]) },
    },
  };
}

describe("Cloud private-alpha public UX", () => {
  test("makes CLI install and docs public while exposing only existing-member sign in", async () => {
    const card = renderToStaticMarkup(createElement(LoginCard));
    const landing = await Bun.file(new URL("../src/app/page.tsx", import.meta.url)).text();
    const publicCopy = `${landing}\n${card}`;

    expect(publicCopy).toContain("SINTER CLOUD · PRIVATE ALPHA");
    expect(card).toContain(`href="${CLI_INSTALL_URL}"`);
    expect(card).toContain(`href="${CLI_DOCS_URL}"`);
    expect(card).toContain("Existing member sign in");
    expect(card.indexOf(`href="${CLI_INSTALL_URL}"`)).toBeLessThan(card.indexOf("Existing member sign in"));
    expect(publicCopy).not.toMatch(/sign[ -]?up|create (?:an? )?account|register (?:an? )?account/i);
  });

  test("renders a fixed access-denied page without reflected request text", () => {
    const html = renderToStaticMarkup(createElement(AccessDenied));

    expect(html).toContain("Cloud is in private alpha");
    expect(html).toContain("No Cloud account was created");
    expect(html).toContain("The Sinter CLI still works");
    expect(html).toContain(`href="${CLI_INSTALL_URL}"`);
    expect(html).not.toContain("searchParams");
    expect(html).not.toContain("provider");
    expect(html).not.toContain("error_description");
  });

  test("reports signups disabled and real uploads disabled by default without exposing configuration", async () => {
    const previous = process.env.SINTER_REAL_UPLOADS_ENABLED;
    delete process.env.SINTER_REAL_UPLOADS_ENABLED;
    const response = health();
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    if (previous === undefined) delete process.env.SINTER_REAL_UPLOADS_ENABLED;
    else process.env.SINTER_REAL_UPLOADS_ENABLED = previous;

    expect(body.publicCloudSignupsEnabled).toBe(false);
    expect(body.realUploadsEnabled).toBe(false);
    expect(Object.keys(body)).not.toContain("signupProvider");
    for (const value of [
      process.env.AUTH0_CLIENT_SECRET,
      process.env.AUTH0_SECRET,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ]) {
      if (value && value.length > 5) expect(serialized).not.toContain(value);
    }
  });

  test("reports real uploads enabled only for the exact server gate", async () => {
    const previous = process.env.SINTER_REAL_UPLOADS_ENABLED;
    process.env.SINTER_REAL_UPLOADS_ENABLED = "true";
    const enabled = await health().json() as Record<string, unknown>;
    process.env.SINTER_REAL_UPLOADS_ENABLED = "TRUE";
    const wrongCase = await health().json() as Record<string, unknown>;
    if (previous === undefined) delete process.env.SINTER_REAL_UPLOADS_ENABLED;
    else process.env.SINTER_REAL_UPLOADS_ENABLED = previous;

    expect(enabled.realUploadsEnabled).toBe(true);
    expect(wrongCase.realUploadsEnabled).toBe(false);
  });
});

describe("Auth0 private-alpha boundary", () => {
  test("maps access_denied to the fixed page without reflecting provider descriptions", async () => {
    const poison = "attacker@example.test <script>provider detail</script>";
    const error = new AuthorizationError({
      cause: new OAuth2Error({ code: "access_denied", message: poison }),
    });

    expect(isAccessDeniedCallback(error)).toBe(true);
    expect(isAccessDeniedCallback({ cause: { cause: error } })).toBe(true);
    const response = await handleAuth0Callback(error, {
      appBaseUrl: "https://cloud.example.test",
      returnTo: `/dashboard?error_description=${encodeURIComponent(poison)}`,
    }, null);
    const body = await response.text();

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://cloud.example.test/access-denied");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(`${body}${response.headers.get("location")}`).not.toContain(poison);
    expect(`${body}${response.headers.get("location")}`).not.toContain("error_description");
  });

  test("keeps other callback failures generic and successful internal returns unchanged", async () => {
    const failed = await handleAuth0Callback(
      new OAuth2Error({ code: "server_error", message: "secret provider failure" }),
      { appBaseUrl: "https://cloud.example.test", returnTo: "/admin" },
      null,
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("Authentication could not be completed.");

    const succeeded = await handleAuth0Callback(
      null,
      { appBaseUrl: "https://cloud.example.test", returnTo: "/admin" },
      null,
    );
    expect(succeeded.headers.get("location")).toBe("https://cloud.example.test/admin");

    const external = await handleAuth0Callback(
      null,
      { appBaseUrl: "https://cloud.example.test", returnTo: "https://attacker.example/steal" },
      null,
    );
    expect(external.headers.get("location")).toBe("https://cloud.example.test/dashboard");
  });

  test("denies an unmarked identity on Sinter clients before the role action", async () => {
    const boundary = auth0Api();
    await privateAlpha.onExecutePostLogin({
      client: { client_id: SINTER_WEB_CLIENT_ID },
      user: { app_metadata: {} },
    }, boundary.api);

    expect(boundary.denied).toEqual(["sinter_private_alpha"]);
    expect(boundary.claims).toEqual([]);
  });

  test("allows approved members and leaves unrelated Auth0 clients untouched", async () => {
    const member = auth0Api();
    await privateAlpha.onExecutePostLogin({
      client: { client_id: SINTER_WEB_CLIENT_ID },
      user: { app_metadata: { sinter_cloud_access: true } },
    }, member.api);
    expect(member.denied).toEqual([]);

    const unrelated = auth0Api();
    await privateAlpha.onExecutePostLogin({
      client: { client_id: "unrelated-client" },
      user: { app_metadata: {} },
    }, unrelated.api);
    expect(unrelated.denied).toEqual([]);
  });

  test("scopes the separate Supabase role claim to Sinter clients", async () => {
    const boundary = auth0Api();
    await roleClaim.onExecutePostLogin({ client: { client_id: SINTER_WEB_CLIENT_ID } }, boundary.api);
    expect(boundary.claims).toEqual([["role", "authenticated"]]);

    const unrelated = auth0Api();
    await roleClaim.onExecutePostLogin({ client: { client_id: "unrelated-client" } }, unrelated.api);
    expect(unrelated.claims).toEqual([]);
  });

  test("has no environment switch that can enable public signup", async () => {
    const gateAction = await Bun.file(new URL("../auth0/private-alpha.js", import.meta.url)).text();
    const roleAction = await Bun.file(new URL("../auth0/post-login.js", import.meta.url)).text();
    const callback = await Bun.file(new URL("../src/lib/auth-callback.ts", import.meta.url)).text();
    const healthRoute = await Bun.file(new URL("../src/app/api/health/route.ts", import.meta.url)).text();

    expect(`${gateAction}\n${roleAction}\n${callback}`).not.toMatch(/process\.env|SIGNUP_ENABLED|PUBLIC_ALPHA/i);
    expect(healthRoute).toContain("publicCloudSignupsEnabled: false");
  });
});

describe("CLI auth sanitization", () => {
  test("does not log or return provider details from CLI auth routes", async () => {
    const routePaths = [
      "../src/app/api/cli/config/route.ts",
      "../src/app/api/cli/session/route.ts",
      "../src/app/api/cli/refresh/route.ts",
      "../src/app/api/cli/logout/route.ts",
    ];

    for (const routePath of routePaths) {
      const source = await Bun.file(new URL(routePath, import.meta.url)).text();
      expect(source).not.toMatch(/console\.(?:log|error|warn|info)/);
      expect(source).not.toContain("error_description");
      expect(source).not.toMatch(/error\?\.message|error\.message/);
    }
  });
});
