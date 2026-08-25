import {
  CliAuthenticationError,
  verifyCliDeviceRequest,
  type CliDeviceIdentity,
} from "./device-auth";
import {
  DEVICE_APPROVAL_SCHEMA,
  DEVICE_REGISTRATION_SCHEMA,
  DEVICE_SUITE,
  DEVICE_UPDATE_SCHEMA,
  DeviceValidationError,
  parseAndVerifyRegistration,
  parseDeviceApproval,
  parseDeviceUpdate,
  validatePublicP256Jwk,
  verifyApprovalSignature,
} from "./device-crypto";
import {
  createDeviceDataSource,
  DeviceDataConfigurationError,
  type DeviceDataSource,
  type DeviceEnrollmentRow,
  type DeviceRow,
} from "./device-data-source";

const ERROR_SCHEMA = "sinter.cloud.error.v1";
const DEVICES_SCHEMA = "sinter.cloud.devices.v1";
const ENROLLMENTS_SCHEMA = "sinter.cloud.device-enrollments.v1";
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 32_768;

interface DeviceHttpDependencies {
  authenticate?: (request: Request) => Promise<CliDeviceIdentity>;
  createSource?: () => DeviceDataSource;
  now?: () => Date;
}

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

class DeviceHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly publicMessage: string,
    public readonly detail: string,
  ) {
    super(publicMessage);
    this.name = "DeviceHttpError";
  }
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function failure(error: unknown) {
  let normalized: DeviceHttpError;
  if (error instanceof DeviceHttpError) {
    normalized = error;
  } else if (error instanceof CliAuthenticationError) {
    normalized = error.kind === "configuration"
      ? new DeviceHttpError(503, "configuration", "Device service is unavailable", error.detail)
      : new DeviceHttpError(401, "unauthorized", "Unauthorized", error.detail);
  } else if (error instanceof DeviceDataConfigurationError) {
    normalized = new DeviceHttpError(503, "configuration", "Device service is unavailable", error.detail);
  } else if (error instanceof DeviceValidationError) {
    normalized = new DeviceHttpError(400, "invalid_request", "Invalid request", error.detail);
  } else {
    normalized = new DeviceHttpError(503, "unavailable", "Device service is unavailable", "Unexpected device service error");
  }
  return response({
    schema: ERROR_SCHEMA,
    ok: false,
    error: { code: normalized.code, message: normalized.publicMessage },
  }, normalized.status);
}

async function boundary(operation: () => Promise<Response>) {
  try {
    return await operation();
  } catch (error) {
    return failure(error);
  }
}

async function requestBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new DeviceHttpError(413, "request_too_large", "Request too large", "Declared request body exceeded limit");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new DeviceHttpError(413, "request_too_large", "Request too large", "Request body exceeded limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DeviceHttpError(400, "invalid_request", "Invalid request", "Request body was not JSON");
  }
}

function dependencies(overrides: DeviceHttpDependencies) {
  return {
    authenticate: overrides.authenticate ?? verifyCliDeviceRequest,
    createSource: overrides.createSource ?? createDeviceDataSource,
    now: overrides.now ?? (() => new Date()),
  };
}

async function accountSource(request: Request, overrides: DeviceHttpDependencies) {
  const deps = dependencies(overrides);
  const identity = await deps.authenticate(request);
  const source = deps.createSource();
  const account = await source.resolveAccountId(identity);
  if (account.error) {
    throw new DeviceHttpError(503, "account_resolution", "Device service is unavailable", account.error.message);
  }
  if (typeof account.data !== "string" || !account.data) {
    throw new DeviceHttpError(403, "account_not_linked", "Cloud account is not linked", "Identity had no explicit account mapping");
  }
  return { accountId: account.data, source, now: deps.now };
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function publicDevice(row: DeviceRow, accountId: string) {
  if (
    row.user_id !== accountId
    || typeof row.id !== "string"
    || typeof row.name !== "string"
    || row.suite !== DEVICE_SUITE
    || !/^[0-9a-f]{64}$/.test(row.fingerprint)
    || !validDate(row.created_at)
    || (row.last_seen_at !== null && !validDate(row.last_seen_at))
    || (row.revoked_at !== null && !validDate(row.revoked_at))
  ) {
    throw new DeviceHttpError(503, "data_integrity", "Device service is unavailable", "Stored device metadata was invalid or cross-account");
  }
  return {
    id: row.id,
    name: row.name,
    suite: row.suite,
    encryptionPublicKey: validatePublicP256Jwk(row.encryption_public_key, "encryption"),
    signingPublicKey: validatePublicP256Jwk(row.signing_public_key, "signing"),
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function publicEnrollment(row: DeviceEnrollmentRow, accountId: string) {
  if (
    row.user_id !== accountId
    || typeof row.id !== "string"
    || typeof row.name !== "string"
    || row.suite !== DEVICE_SUITE
    || !/^[0-9a-f]{64}$/.test(row.fingerprint)
    || !validDate(row.created_at)
    || !validDate(row.expires_at)
  ) {
    throw new DeviceHttpError(503, "data_integrity", "Device service is unavailable", "Stored enrollment metadata was invalid or cross-account");
  }
  return {
    id: row.id,
    name: row.name,
    suite: row.suite,
    encryptionPublicKey: validatePublicP256Jwk(row.encryption_public_key, "encryption"),
    signingPublicKey: validatePublicP256Jwk(row.signing_public_key, "signing"),
    requestFingerprint: row.fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function ensureUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DeviceHttpError(400, "invalid_request", "Invalid request", `${label} was not a UUID`);
  }
}

function ensureResult<T>(
  result: { data: T | null; error: { message: string } | null },
  operation: string,
): T {
  if (result.error) {
    throw new DeviceHttpError(503, "data_operation", "Device service is unavailable", `${operation}: ${result.error.message}`);
  }
  if (!result.data) {
    throw new DeviceHttpError(409, "operation_rejected", "Request cannot be completed", `${operation} returned no row`);
  }
  return result.data;
}

export function createDevicesRoute(overrides: DeviceHttpDependencies = {}) {
  return {
    GET: (request: Request) => boundary(async () => {
      const { accountId, source } = await accountSource(request, overrides);
      const listed = await source.listDevices(accountId);
      if (listed.error) {
        throw new DeviceHttpError(503, "device_list", "Device service is unavailable", listed.error.message);
      }
      const devices = (listed.data ?? []).map((row) => publicDevice(row, accountId));
      return response({ schema: DEVICES_SCHEMA, ok: true, devices });
    }),

    POST: (request: Request) => boundary(async () => {
      const { accountId, source, now } = await accountSource(request, overrides);
      const registration = parseAndVerifyRegistration(await requestBody(request));
      const listed = await source.listDevices(accountId);
      if (listed.error) {
        throw new DeviceHttpError(503, "device_list", "Device service is unavailable", listed.error.message);
      }
      const accountDevices = (listed.data ?? []).filter((device) => device.user_id === accountId);
      if (accountDevices.length === 0) {
        const registered = ensureResult(
          await source.bootstrapDevice(accountId, registration),
          "First-device bootstrap",
        );
        return response({
          schema: DEVICE_REGISTRATION_SCHEMA,
          ok: true,
          status: "registered",
          device: publicDevice(registered, accountId),
        }, 201);
      }
      if (!accountDevices.some((device) => device.revoked_at === null)) {
        throw new DeviceHttpError(
          409,
          "device_recovery_unavailable",
          "An active device is required to approve registration",
          "The account has device history but no active approving device",
        );
      }

      const expiresAt = new Date(now().getTime() + ENROLLMENT_TTL_MS).toISOString();
      const enrollment = ensureResult(
        await source.createEnrollment(accountId, registration, expiresAt),
        "Enrollment creation",
      );
      const visible = publicEnrollment(enrollment, accountId);
      return response({
        schema: DEVICE_REGISTRATION_SCHEMA,
        ok: true,
        status: "approval_required",
        request: {
          id: visible.id,
          requestFingerprint: visible.requestFingerprint,
          expiresAt: visible.expiresAt,
        },
      }, 202);
    }),
  };
}

export function createDevicePatchRoute(overrides: DeviceHttpDependencies = {}) {
  return {
    PATCH: (request: Request, context: RouteContext) => boundary(async () => {
      const { id } = await context.params;
      ensureUuid(id, "Device ID");
      const { accountId, source, now } = await accountSource(request, overrides);
      const update = parseDeviceUpdate(await requestBody(request));
      const databaseUpdate = update.name !== undefined
        ? { name: update.name }
        : { revoked_at: now().toISOString() };
      const changed = await source.updateDevice(accountId, id, databaseUpdate);
      if (changed.error) {
        throw new DeviceHttpError(503, "device_update", "Device service is unavailable", changed.error.message);
      }
      if (!changed.data) {
        throw new DeviceHttpError(404, "device_not_found", "Device not found", "Scoped device update selected no row");
      }
      return response({
        schema: DEVICE_UPDATE_SCHEMA,
        ok: true,
        device: publicDevice(changed.data, accountId),
      });
    }),
  };
}

export function createEnrollmentsRoute(overrides: DeviceHttpDependencies = {}) {
  return {
    GET: (request: Request) => boundary(async () => {
      const { accountId, source, now } = await accountSource(request, overrides);
      const listed = await source.listEnrollments(accountId);
      if (listed.error) {
        throw new DeviceHttpError(503, "enrollment_list", "Device service is unavailable", listed.error.message);
      }
      const currentTime = now().getTime();
      const enrollments = (listed.data ?? [])
        .filter((row) =>
          (row.status === "pending" || row.status === "approved")
          && row.completed_device_id === null
          && Date.parse(row.expires_at) > currentTime
        )
        .map((row) => publicEnrollment(row, accountId));
      return response({ schema: ENROLLMENTS_SCHEMA, ok: true, enrollments });
    }),
  };
}

export function createEnrollmentApprovalRoute(overrides: DeviceHttpDependencies = {}) {
  return {
    POST: (request: Request, context: RouteContext) => boundary(async () => {
      const { id: requestId } = await context.params;
      ensureUuid(requestId, "Enrollment request ID");
      const { accountId, source, now } = await accountSource(request, overrides);
      const approval = parseDeviceApproval(await requestBody(request));

      const enrollmentResult = await source.loadEnrollment(accountId, requestId);
      if (enrollmentResult.error) {
        throw new DeviceHttpError(503, "enrollment_load", "Device service is unavailable", enrollmentResult.error.message);
      }
      const enrollment = enrollmentResult.data;
      if (!enrollment || enrollment.user_id !== accountId || enrollment.id !== requestId) {
        throw new DeviceHttpError(404, "enrollment_not_found", "Enrollment request not found", "Scoped enrollment lookup selected no matching row");
      }
      if (
        !["pending", "approved"].includes(enrollment.status)
        || enrollment.completed_device_id !== null
        || (enrollment.status === "pending" && enrollment.approved_at !== null)
        || (enrollment.status === "approved" && (
          enrollment.approved_at === null
          || enrollment.approver_device_id !== approval.approverDeviceId
        ))
      ) {
        throw new DeviceHttpError(409, "enrollment_replayed", "Enrollment request was already used", "Enrollment was not safely retryable");
      }
      if (!validDate(enrollment.expires_at) || Date.parse(enrollment.expires_at) <= now().getTime()) {
        throw new DeviceHttpError(409, "enrollment_expired", "Enrollment request has expired", "Enrollment expiry was not in the future");
      }

      const approverResult = await source.loadActiveDevice(accountId, approval.approverDeviceId);
      if (approverResult.error) {
        throw new DeviceHttpError(503, "approver_load", "Device service is unavailable", approverResult.error.message);
      }
      const approver = approverResult.data;
      if (
        !approver
        || approver.id !== approval.approverDeviceId
        || approver.user_id !== accountId
        || approver.revoked_at !== null
      ) {
        throw new DeviceHttpError(403, "approver_ineligible", "Approver device is not eligible", "Approver was missing, mismatched, cross-account, or revoked");
      }
      try {
        verifyApprovalSignature(
          approver.signing_public_key,
          approval,
          enrollment.id,
          enrollment.fingerprint,
          enrollment.expires_at,
        );
      } catch (error) {
        if (error instanceof DeviceValidationError) {
          throw new DeviceHttpError(403, "invalid_approval", "Approval signature is invalid", error.detail);
        }
        throw error;
      }

      const completed = await source.completeEnrollment(
        accountId,
        requestId,
        approval.approverDeviceId,
        approval.signature,
      );
      if (completed.error || !completed.data) {
        throw new DeviceHttpError(
          409,
          "enrollment_completion_rejected",
          "Enrollment request cannot be completed",
          completed.error?.message ?? "Completion RPC returned no row",
        );
      }
      return response({
        schema: DEVICE_APPROVAL_SCHEMA,
        ok: true,
        status: "registered",
        device: publicDevice(completed.data, accountId),
      });
    }),
  };
}
