import { NextResponse } from "next/server";
import type { OnCallbackHook } from "@auth0/nextjs-auth0/types";

interface CallbackErrorLike {
  code?: unknown;
  cause?: unknown;
}

function errorCode(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const code = (value as CallbackErrorLike).code;
  return typeof code === "string" ? code : null;
}

export function isAccessDeniedCallback(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (errorCode(current) === "access_denied") return true;
    current = (current as CallbackErrorLike).cause;
  }
  return false;
}

function redirectTarget(returnTo: unknown) {
  if (typeof returnTo !== "string" || !returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\")) {
    return "/dashboard";
  }
  return returnTo;
}

export const handleAuth0Callback: OnCallbackHook = async (error, context) => {
  if (!context.appBaseUrl) {
    return new NextResponse("Authentication could not be completed.", {
      status: 500,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  if (isAccessDeniedCallback(error)) {
    return NextResponse.redirect(new URL("/access-denied", context.appBaseUrl), {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  if (error) {
    return new NextResponse("Authentication could not be completed.", {
      status: 500,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return NextResponse.redirect(new URL(redirectTarget(context.returnTo), context.appBaseUrl), {
    headers: { "Cache-Control": "private, no-store" },
  });
};
