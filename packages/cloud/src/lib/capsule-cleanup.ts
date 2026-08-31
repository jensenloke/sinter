import { timingSafeEqual } from "node:crypto";
import { createCapsuleDataSource } from "./capsule-data-source";

export const CAPSULE_CLEANUP_BATCH_LIMIT = 100;
export const CAPSULE_NONCE_CLEANUP_BATCH_LIMIT = 1000;
export const CAPSULE_CLEANUP_SCHEMA = "sinter.cloud.capsule-cleanup.v1";

interface CleanupResult<T> {
  data: T;
  error: { message: string; code?: string } | null;
}

interface CapsuleCleanupSource {
  expireReservations(limit?: number): Promise<CleanupResult<unknown[] | null>>;
  expireRequestNonces(limit?: number): Promise<CleanupResult<number | null>>;
}

interface CapsuleCleanupDependencies {
  cronSecret?: () => string | undefined;
  createSource?: () => CapsuleCleanupSource;
}

function authorized(request: Request, secret: string | undefined) {
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function response(status: number, ok: boolean, expiredReservations: number, expiredRequestNonces: number) {
  return Response.json(
    {
      schema: CAPSULE_CLEANUP_SCHEMA,
      ok,
      expiredReservations,
      expiredRequestNonces,
    },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function createCapsuleCleanupHandler(overrides: CapsuleCleanupDependencies = {}) {
  const cronSecret = overrides.cronSecret ?? (() => process.env.CRON_SECRET);
  const sourceFactory = overrides.createSource ?? createCapsuleDataSource;

  return async function GET(request: Request) {
    if (!authorized(request, cronSecret())) return response(401, false, 0, 0);

    let source: CapsuleCleanupSource;
    try {
      source = sourceFactory();
    } catch {
      return response(503, false, 0, 0);
    }

    try {
      const [reservations, nonces] = await Promise.all([
        source.expireReservations(CAPSULE_CLEANUP_BATCH_LIMIT),
        source.expireRequestNonces(CAPSULE_NONCE_CLEANUP_BATCH_LIMIT),
      ]);
      const expiredReservations = Array.isArray(reservations.data) ? reservations.data.length : 0;
      const expiredRequestNonces = Number.isSafeInteger(nonces.data) && (nonces.data ?? -1) >= 0 ? nonces.data! : 0;
      if (reservations.error || !Array.isArray(reservations.data) || nonces.error || expiredRequestNonces !== nonces.data) {
        return response(502, false, expiredReservations, expiredRequestNonces);
      }
      return response(200, true, expiredReservations, expiredRequestNonces);
    } catch {
      return response(502, false, 0, 0);
    }
  };
}
