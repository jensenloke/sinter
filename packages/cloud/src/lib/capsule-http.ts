import {
  CliAuthenticationError,
  verifyCliDeviceRequest,
  type CliDeviceIdentity,
} from "./device-auth";
import {
  CapsuleDataConfigurationError,
  createCapsuleDataSource,
  type CapsuleDataError,
  type CapsuleDataResult,
  type CapsuleDataSource,
  type CapsuleDevice,
  type CapsuleReservationInput,
  type CapsuleRow,
} from "./capsule-data-source";
import {
  CapsuleRequestProofError,
  capsuleRequestBodySha256,
  verifyCapsuleRequestProof,
} from "./capsule-request-proof";

export const CAPSULE_ERROR_SCHEMA = "sinter.cloud.error.v1";
export const CAPSULE_LIST_SCHEMA = "sinter.cloud.capsules.v1";
export const CAPSULE_METADATA_SCHEMA = "sinter.cloud.capsule-metadata.v1";
export const CAPSULE_RESERVE_SCHEMA = "sinter.cloud.capsule-reserve.v1";
export const CAPSULE_RESERVATION_SCHEMA = "sinter.cloud.capsule-reservation.v1";
export const CAPSULE_FINALIZE_SCHEMA = "sinter.cloud.capsule-finalize.v1";
export const CAPSULE_FINALIZATION_SCHEMA = "sinter.cloud.capsule-finalization.v1";
export const CAPSULE_DOWNLOAD_REQUEST_SCHEMA = "sinter.cloud.capsule-download-request.v1";
export const CAPSULE_DOWNLOAD_SCHEMA = "sinter.cloud.capsule-download.v1";
export const CAPSULE_DELETION_SCHEMA = "sinter.cloud.capsule-deletion.v1";

const MAX_BODY_BYTES = 32_768;
const MAX_CAPSULE_BYTES = 64 * 1024 * 1024;
const MAX_RECIPIENTS = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPSULE_ID_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SCHEMA_PATTERN = /^[a-z][a-z0-9.-]*\.v[0-9]+$/;

export interface CapsuleDeviceAuthorization {
  accountId: string;
  deviceId: string;
  device: CapsuleDevice;
}

export interface CapsuleDeviceAuthorizationInput {
  source: CapsuleDataSource;
  accountId: string;
  deviceId: string;
  request: Request;
  method: string;
  pathname: string;
  bodyBytes: Uint8Array;
  now: Date;
}

export interface CapsuleHttpDependencies {
  authenticate?: (request: Request) => Promise<CliDeviceIdentity>;
  createSource?: () => CapsuleDataSource;
  uploadsEnabled?: () => boolean;
  authorizeDevice?: (input: CapsuleDeviceAuthorizationInput) => Promise<CapsuleDeviceAuthorization>;
  now?: () => Date;
}

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

class CapsuleHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly publicMessage: string,
    public readonly detail: string,
  ) {
    super(publicMessage);
    this.name = "CapsuleHttpError";
  }
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function failure(error: unknown) {
  let normalized: CapsuleHttpError;
  if (error instanceof CapsuleHttpError) {
    normalized = error;
  } else if (error instanceof CliAuthenticationError) {
    normalized = error.kind === "configuration"
      ? new CapsuleHttpError(503, "configuration", "Capsule service is unavailable", error.detail)
      : new CapsuleHttpError(401, "unauthorized", "Unauthorized", error.detail);
  } else if (error instanceof CapsuleDataConfigurationError) {
    normalized = new CapsuleHttpError(503, "configuration", "Capsule service is unavailable", error.detail);
  } else {
    normalized = new CapsuleHttpError(503, "unavailable", "Capsule service is unavailable", "Unexpected capsule service error");
  }
  return response({
    schema: CAPSULE_ERROR_SCHEMA,
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

function exactObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", `${label} was not an object`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", `${label} fields were not canonical`);
  }
  return object;
}

async function requestBytes(request: Request, bodyAllowed: boolean): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^(0|[1-9][0-9]{0,5})$/.test(declared)) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Content length was invalid");
  }
  const declaredLength = Number(declared ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new CapsuleHttpError(413, "request_too_large", "Request too large", "Declared body exceeded the request limit");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new CapsuleHttpError(413, "request_too_large", "Request too large", "Body exceeded the request limit");
  }
  if (declared !== null && declaredLength !== bytes.byteLength) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Content length did not match the body");
  }
  if (!bodyAllowed && bytes.byteLength !== 0) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "This method requires an empty body");
  }
  return bytes;
}

function requestBody(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Request body was not UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Body was not JSON");
  }
}

function boundedString(value: unknown, pattern: RegExp, maximum: number, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", `${label} was invalid`);
  }
  return value;
}

function capsuleId(value: unknown) {
  const encoded = boundedString(value, CAPSULE_ID_PATTERN, 22, "Capsule ID");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 16 || decoded.toString("base64url") !== encoded) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Capsule ID was not canonical");
  }
  return encoded;
}

function uuid(value: unknown, label: string) {
  const result = boundedString(value, UUID_PATTERN, 36, label);
  if (result !== result.toLowerCase()) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", `${label} was not canonical`);
  }
  return result;
}

function serializedBytes(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_CAPSULE_BYTES) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Serialized byte count was invalid");
  }
  return value as number;
}

function schemaIdentifier(value: unknown, label: string) {
  return boundedString(value, SCHEMA_PATTERN, 128, label);
}

function parseReservation(value: unknown): CapsuleReservationInput {
  const object = exactObject(value, [
    "schema",
    "capsuleId",
    "serializedBytes",
    "serializedSha256",
    "outerSchema",
    "payloadSchema",
    "transferSchema",
    "senderFingerprint",
    "recipientFingerprints",
  ], "Capsule reservation");
  if (object.schema !== CAPSULE_RESERVE_SCHEMA) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Reservation schema was unsupported");
  }
  if (!Array.isArray(object.recipientFingerprints)
    || object.recipientFingerprints.length < 1
    || object.recipientFingerprints.length > MAX_RECIPIENTS) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Recipient set was invalid");
  }
  const recipientFingerprints = object.recipientFingerprints.map((fingerprint) =>
    boundedString(fingerprint, FINGERPRINT_PATTERN, 64, "Recipient fingerprint"));
  const canonicalRecipients = [...recipientFingerprints].sort();
  if (
    canonicalRecipients.some((fingerprint, index) => fingerprint !== recipientFingerprints[index])
    || new Set(recipientFingerprints).size !== recipientFingerprints.length
  ) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Recipient set was not canonical");
  }
  return {
    capsuleId: capsuleId(object.capsuleId),
    serializedBytes: serializedBytes(object.serializedBytes),
    serializedSha256: boundedString(object.serializedSha256, HASH_PATTERN, 64, "Serialized hash"),
    outerSchema: schemaIdentifier(object.outerSchema, "Outer schema"),
    payloadSchema: schemaIdentifier(object.payloadSchema, "Payload schema"),
    transferSchema: schemaIdentifier(object.transferSchema, "Transfer schema"),
    senderFingerprint: boundedString(object.senderFingerprint, FINGERPRINT_PATTERN, 64, "Sender fingerprint"),
    recipientFingerprints,
  };
}

function parseFinalize(value: unknown) {
  const object = exactObject(
    value,
    ["schema", "serializedBytes", "serializedSha256"],
    "Capsule finalization",
  );
  if (object.schema !== CAPSULE_FINALIZE_SCHEMA) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Finalization schema was unsupported");
  }
  return {
    serializedBytes: serializedBytes(object.serializedBytes),
    serializedSha256: boundedString(object.serializedSha256, HASH_PATTERN, 64, "Serialized hash"),
  };
}

function parseDownload(value: unknown) {
  const object = exactObject(value, ["schema"], "Capsule download request");
  if (object.schema !== CAPSULE_DOWNLOAD_REQUEST_SCHEMA) {
    throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Download schema was unsupported");
  }
}

function dependencies(overrides: CapsuleHttpDependencies) {
  return {
    authenticate: overrides.authenticate ?? verifyCliDeviceRequest,
    createSource: overrides.createSource ?? createCapsuleDataSource,
    uploadsEnabled: overrides.uploadsEnabled ?? (() => process.env.SINTER_REAL_UPLOADS_ENABLED === "true"),
    authorizeDevice: overrides.authorizeDevice ?? defaultAuthorizeDevice,
    now: overrides.now ?? (() => new Date()),
  };
}

function proofHeader(request: Request, name: string, maximum: number) {
  const value = request.headers.get(name);
  if (!value || value.length > maximum) {
    throw new CapsuleHttpError(400, "invalid_request_proof", "Invalid request proof", "A bounded request proof header was missing or invalid");
  }
  return value;
}

async function defaultAuthorizeDevice(
  input: CapsuleDeviceAuthorizationInput,
): Promise<CapsuleDeviceAuthorization> {
  const loaded = await input.source.loadActiveDevice(input.accountId, input.deviceId);
  if (loaded.error) {
    throw new CapsuleHttpError(503, "device_lookup", "Capsule service is unavailable", "Active device lookup failed");
  }
  if (
    !loaded.data
    || loaded.data.id !== input.deviceId
    || loaded.data.account_id !== input.accountId
    || !FINGERPRINT_PATTERN.test(loaded.data.fingerprint)
  ) {
    throw new CapsuleHttpError(403, "device_ineligible", "Active account device required", "Device was missing, inactive, or cross-account");
  }

  const timestamp = proofHeader(input.request, "x-sinter-request-timestamp", 24);
  const nonce = proofHeader(input.request, "x-sinter-request-nonce", 43);
  const signature = proofHeader(input.request, "x-sinter-request-signature", 86);
  try {
    verifyCapsuleRequestProof(
      loaded.data.signing_public_key,
      {
        deviceId: input.deviceId,
        method: input.method,
        pathname: input.pathname,
        bodySha256: capsuleRequestBodySha256(input.bodyBytes),
        timestamp,
        nonce,
      },
      signature,
      input.now,
    );
  } catch (error) {
    if (error instanceof CapsuleRequestProofError && error.kind === "stale") {
      throw new CapsuleHttpError(401, "stale_request_proof", "Request proof has expired", "Request proof timestamp was outside the accepted window");
    }
    throw new CapsuleHttpError(401, "invalid_request_proof", "Invalid request proof", "Request proof did not verify");
  }

  const claimed = await input.source.claimRequestNonce(
    input.accountId,
    input.deviceId,
    nonce,
    timestamp,
  );
  if (claimed.error?.code === "PT409" && claimed.error.message === "capsule_request_replay") {
    throw new CapsuleHttpError(409, "request_replay", "Request proof was already used", "Request nonce was already claimed");
  }
  if (claimed.error?.code === "42501") {
    throw new CapsuleHttpError(403, "device_ineligible", "Active account device required", "Device became ineligible before nonce claim");
  }
  if (claimed.error?.code === "22023") {
    throw new CapsuleHttpError(401, "invalid_request_proof", "Invalid request proof", "Database request proof bounds were not satisfied");
  }
  if (claimed.error) {
    throw new CapsuleHttpError(503, "nonce_claim", "Capsule service is unavailable", "Request nonce claim failed");
  }
  if (claimed.data !== true) {
    throw new CapsuleHttpError(503, "nonce_claim", "Capsule service is unavailable", "Request nonce claim returned no result");
  }
  return { accountId: input.accountId, deviceId: input.deviceId, device: loaded.data };
}

async function accountContext<T>(
  request: Request,
  expectedMethod: "GET" | "POST" | "DELETE",
  expectedPathname: string,
  parseBody: ((bytes: Uint8Array) => T) | null,
  requireUploadGate: boolean,
  overrides: CapsuleHttpDependencies,
) {
  const deps = dependencies(overrides);
  if (requireUploadGate && !deps.uploadsEnabled()) {
    throw new CapsuleHttpError(503, "uploads_disabled", "Capsule service is unavailable", "Server upload gate is disabled");
  }
  const url = new URL(request.url);
  if (request.method !== expectedMethod || url.pathname !== expectedPathname || url.search !== "") {
    throw new CapsuleHttpError(400, "invalid_request_target", "Invalid request target", "Request method or pathname did not match the route");
  }
  const bodyBytes = await requestBytes(request, parseBody !== null);
  const parsedBody = parseBody?.(bodyBytes) ?? null;
  const identity = await deps.authenticate(request);
  const source = deps.createSource();
  const account = await source.resolveAccountId(identity);
  if (account.error) {
    throw new CapsuleHttpError(503, "account_resolution", "Capsule service is unavailable", "Explicit account resolution failed");
  }
  if (typeof account.data !== "string" || !account.data) {
    throw new CapsuleHttpError(403, "account_not_linked", "Cloud account is not linked", "Identity had no explicit account mapping");
  }
  const deviceId = uuid(request.headers.get("x-sinter-device-id"), "Device ID");
  const authorization = await deps.authorizeDevice({
    source,
    accountId: account.data,
    deviceId,
    request,
    method: expectedMethod,
    pathname: expectedPathname,
    bodyBytes,
    now: deps.now(),
  });
  if (authorization.accountId !== account.data || authorization.deviceId !== deviceId) {
    throw new CapsuleHttpError(403, "device_ineligible", "Active account device required", "Authorization returned a mismatched device scope");
  }
  return { accountId: account.data, source, authorization, bodyBytes, parsedBody };
}

function dataFailure(error: CapsuleDataError, operation: string): never {
  if (error.code === "42501") {
    throw new CapsuleHttpError(403, "operation_not_allowed", "Capsule operation is not allowed", `${operation} was denied`);
  }
  if (
    error.code === "PT409"
    && ["capsule_size_quota_exceeded", "capsule_account_quota_exceeded"].includes(error.message)
  ) {
    throw new CapsuleHttpError(409, "quota_exceeded", "Capsule quota exceeded", `${operation} exceeded quota`);
  }
  if (error.code === "CAPSULE_OBJECT_NOT_FOUND") {
    throw new CapsuleHttpError(404, "capsule_object_not_uploaded", "Capsule object was not found", `${operation} found no stored object`);
  }
  if (error.code === "CAPSULE_OBJECT_READ_FAILED") {
    throw new CapsuleHttpError(409, "capsule_object_unreadable", "Capsule object could not be verified", `${operation} could not read the stored object`);
  }
  if (
    (error.code === "PT409" && [
      "capsule_reservation_conflict",
      "capsule_finalize_mismatch",
      "capsule_delete_mismatch",
    ].includes(error.message))
    || error.code === "CAPSULE_FINALIZE_MISMATCH"
    || error.code === "CAPSULE_OBJECT_SIZE_MISMATCH"
    || error.code === "CAPSULE_OBJECT_HASH_MISMATCH"
  ) {
    throw new CapsuleHttpError(409, "capsule_mismatch", "Capsule metadata does not match", `${operation} metadata mismatched`);
  }
  if (error.code === "PT409" || error.code === "CAPSULE_NOT_DOWNLOADABLE") {
    throw new CapsuleHttpError(409, "capsule_conflict", "Capsule state conflicts with this request", `${operation} conflicted`);
  }
  throw new CapsuleHttpError(503, "data_operation", "Capsule service is unavailable", `${operation} failed`);
}

function required<T>(result: CapsuleDataResult<T | null>, operation: string): T {
  if (result.error) dataFailure(result.error, operation);
  if (!result.data) {
    throw new CapsuleHttpError(409, "capsule_conflict", "Capsule state conflicts with this request", `${operation} returned no row`);
  }
  return result.data;
}

async function requireCapsuleRead(
  source: CapsuleDataSource,
  accountId: string,
  deviceId: string,
) {
  const authorized = await source.authorizeCapsuleRead(accountId, deviceId);
  if (authorized.error) dataFailure(authorized.error, "Capsule read authorization");
  if (authorized.data !== true) {
    throw new CapsuleHttpError(403, "operation_not_allowed", "Capsule operation is not allowed", "Capsule read authorization returned no result");
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function publicCapsule(row: CapsuleRow, accountId: string) {
  if (
    row.account_id !== accountId
    || !CAPSULE_ID_PATTERN.test(row.capsule_id)
    || !Number.isSafeInteger(row.serialized_bytes)
    || row.serialized_bytes < 1
    || row.serialized_bytes > MAX_CAPSULE_BYTES
    || !HASH_PATTERN.test(row.serialized_sha256)
    || !SCHEMA_PATTERN.test(row.outer_schema)
    || !SCHEMA_PATTERN.test(row.payload_schema)
    || !SCHEMA_PATTERN.test(row.transfer_schema)
    || !FINGERPRINT_PATTERN.test(row.sender_fingerprint)
    || !Array.isArray(row.recipient_fingerprints)
    || row.recipient_fingerprints.length !== row.recipient_count
    || row.recipient_fingerprints.some((fingerprint) => !FINGERPRINT_PATTERN.test(fingerprint))
    || !["reserved", "retained", "delete_pending", "deleted", "expiry_pending", "expired"].includes(row.status)
    || !validDate(row.reserved_at)
    || !validDate(row.reservation_refreshed_at)
    || !validDate(row.reservation_expires_at)
    || (row.finalized_at !== null && !validDate(row.finalized_at))
    || (row.deletion_requested_at !== null && !validDate(row.deletion_requested_at))
    || (row.storage_deleted_at !== null && !validDate(row.storage_deleted_at))
    || (row.expiry_requested_at !== null && !validDate(row.expiry_requested_at))
    || (row.storage_cleanup_completed_at !== null && !validDate(row.storage_cleanup_completed_at))
    || (row.expired_at !== null && !validDate(row.expired_at))
  ) {
    throw new CapsuleHttpError(503, "data_integrity", "Capsule service is unavailable", "Stored capsule metadata was invalid or cross-account");
  }
  return {
    id: row.capsule_id,
    serializedBytes: row.serialized_bytes,
    serializedSha256: row.serialized_sha256,
    outerSchema: row.outer_schema,
    payloadSchema: row.payload_schema,
    transferSchema: row.transfer_schema,
    senderFingerprint: row.sender_fingerprint,
    recipientFingerprints: row.recipient_fingerprints,
    recipientCount: row.recipient_count,
    status: row.status,
    reservedAt: row.reserved_at,
    reservationRefreshedAt: row.reservation_refreshed_at,
    reservationExpiresAt: row.reservation_expires_at,
    finalizedAt: row.finalized_at,
    deletionRequestedAt: row.deletion_requested_at,
    storageDeletedAt: row.storage_deleted_at,
    expiryRequestedAt: row.expiry_requested_at,
    storageCleanupCompletedAt: row.storage_cleanup_completed_at,
    expiredAt: row.expired_at,
  };
}

export function createCapsulesRoute(overrides: CapsuleHttpDependencies = {}) {
  return {
    GET: (request: Request) => boundary(async () => {
      const { accountId, source, authorization } = await accountContext(
        request,
        "GET",
        "/api/cli/capsules",
        null,
        true,
        overrides,
      );
      await requireCapsuleRead(source, accountId, authorization.deviceId);
      const listed = await source.listCapsules(accountId);
      if (listed.error) dataFailure(listed.error, "Capsule listing");
      const capsules = (listed.data ?? []).map((capsule) => publicCapsule(capsule, accountId));
      return response({ schema: CAPSULE_LIST_SCHEMA, ok: true, capsules });
    }),

    POST: (request: Request) => boundary(async () => {
      const { accountId, source, authorization, parsedBody: input } = await accountContext(
        request,
        "POST",
        "/api/cli/capsules",
        (bytes) => parseReservation(requestBody(bytes)),
        true,
        overrides,
      );
      if (!input) {
        throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Reservation body was missing");
      }
      if (input.senderFingerprint !== authorization.device.fingerprint) {
        throw new CapsuleHttpError(403, "sender_mismatch", "Sender device does not match", "Sender fingerprint did not match the authenticated device");
      }
      const reserved = required(
        await source.reserveCapsule(accountId, authorization.deviceId, input),
        "Capsule reservation",
      );
      return response({
        schema: CAPSULE_RESERVATION_SCHEMA,
        ok: true,
        capsule: publicCapsule(reserved.capsule, accountId),
        upload: { url: reserved.signedUploadUrl, method: "PUT", contentType: "application/octet-stream" },
      }, 201);
    }),
  };
}

export function createCapsuleRoute(overrides: CapsuleHttpDependencies = {}) {
  return {
    GET: (request: Request, context: RouteContext) => boundary(async () => {
      const { id } = await context.params;
      capsuleId(id);
      const { accountId, source, authorization } = await accountContext(
        request,
        "GET",
        `/api/cli/capsules/${id}`,
        null,
        true,
        overrides,
      );
      await requireCapsuleRead(source, accountId, authorization.deviceId);
      const loaded = await source.inspectCapsule(accountId, id);
      if (loaded.error) dataFailure(loaded.error, "Capsule inspection");
      if (!loaded.data || loaded.data.account_id !== accountId) {
        throw new CapsuleHttpError(404, "capsule_not_found", "Capsule not found", "Scoped capsule lookup selected no row");
      }
      return response({ schema: CAPSULE_METADATA_SCHEMA, ok: true, capsule: publicCapsule(loaded.data, accountId) });
    }),

    DELETE: (request: Request, context: RouteContext) => boundary(async () => {
      const { id } = await context.params;
      capsuleId(id);
      const { accountId, source, authorization } = await accountContext(
        request,
        "DELETE",
        `/api/cli/capsules/${id}`,
        null,
        false,
        overrides,
      );
      const deleted = required(
        await source.deleteCapsule(accountId, authorization.deviceId, id),
        "Capsule deletion",
      );
      return response({
        schema: CAPSULE_DELETION_SCHEMA,
        ok: true,
        capsule: publicCapsule(deleted, accountId),
      });
    }),
  };
}

export function createCapsuleFinalizeRoute(overrides: CapsuleHttpDependencies = {}) {
  return {
    POST: (request: Request, context: RouteContext) => boundary(async () => {
      const { id } = await context.params;
      capsuleId(id);
      const { accountId, source, authorization, parsedBody: input } = await accountContext(
        request,
        "POST",
        `/api/cli/capsules/${id}/finalize`,
        (bytes) => parseFinalize(requestBody(bytes)),
        true,
        overrides,
      );
      if (!input) {
        throw new CapsuleHttpError(400, "invalid_request", "Invalid request", "Finalization body was missing");
      }
      const finalized = required(
        await source.finalizeCapsule(
          accountId,
          authorization.deviceId,
          id,
          input.serializedBytes,
          input.serializedSha256,
        ),
        "Capsule finalization",
      );
      return response({
        schema: CAPSULE_FINALIZATION_SCHEMA,
        ok: true,
        capsule: publicCapsule(finalized, accountId),
      });
    }),
  };
}

export function createCapsuleDownloadRoute(overrides: CapsuleHttpDependencies = {}) {
  return {
    POST: (request: Request, context: RouteContext) => boundary(async () => {
      const { id } = await context.params;
      capsuleId(id);
      const { accountId, source, authorization } = await accountContext(
        request,
        "POST",
        `/api/cli/capsules/${id}/download`,
        (bytes) => parseDownload(requestBody(bytes)),
        true,
        overrides,
      );
      await requireCapsuleRead(source, accountId, authorization.deviceId);
      const download = required(await source.createDownload(accountId, id), "Capsule download");
      return response({
        schema: CAPSULE_DOWNLOAD_SCHEMA,
        ok: true,
        capsule: publicCapsule(download.capsule, accountId),
        download: { url: download.signedDownloadUrl, expiresInSeconds: download.expiresInSeconds },
      });
    }),
  };
}
