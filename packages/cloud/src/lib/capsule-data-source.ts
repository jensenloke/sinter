import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CliDeviceIdentity } from "./device-auth";
import { validatePublicP256Jwk, type PublicP256Jwk } from "./device-crypto";

export const CAPSULE_BUCKET = "capsules";

export const CAPSULE_DATABASE = Object.freeze({
  accountIdentitiesTable: "account_identities",
  devicesTable: "devices",
  capsulesTable: "capsules",
  recipientsTable: "capsule_recipients",
  reserveRpc: "reserve_capsule",
  finalizeRpc: "finalize_capsule",
  beginDeleteRpc: "begin_capsule_delete",
  finalizeDeleteRpc: "finalize_capsule_delete",
  expireRpc: "expire_capsule_reservations",
  finalizeExpiryRpc: "finalize_capsule_reservation_expiry",
  authorizeReadRpc: "authorize_capsule_read",
  claimNonceRpc: "claim_capsule_request_nonce",
  expireNoncesRpc: "expire_capsule_request_nonces",
});

export interface CapsuleDataError {
  message: string;
  code?: string;
}

export interface CapsuleDataResult<T> {
  data: T;
  error: CapsuleDataError | null;
}

export type CapsuleStatus = "reserved" | "retained" | "delete_pending" | "deleted" | "expiry_pending" | "expired";

export interface CapsuleRow {
  account_id: string;
  capsule_id: string;
  object_path: string;
  serialized_bytes: number;
  serialized_sha256: string;
  outer_schema: string;
  payload_schema: string;
  transfer_schema: string;
  sender_fingerprint: string;
  recipient_count: number;
  recipient_fingerprints: string[];
  status: CapsuleStatus;
  reserved_at: string;
  reservation_refreshed_at: string;
  reservation_expires_at: string;
  finalized_at: string | null;
  deletion_requested_at: string | null;
  storage_deleted_at: string | null;
  expiry_requested_at: string | null;
  storage_cleanup_completed_at: string | null;
  expired_at: string | null;
}

export interface CapsuleDevice {
  id: string;
  account_id: string;
  fingerprint: string;
  signing_public_key: PublicP256Jwk;
}

export interface CapsuleReservationInput {
  capsuleId: string;
  serializedBytes: number;
  serializedSha256: string;
  outerSchema: string;
  payloadSchema: string;
  transferSchema: string;
  senderFingerprint: string;
  recipientFingerprints: string[];
}

export interface CapsuleReservationResult {
  capsule: CapsuleRow;
  signedUploadUrl: string;
}

export interface CapsuleDownloadResult {
  capsule: CapsuleRow;
  signedDownloadUrl: string;
  expiresInSeconds: number;
}

export interface CapsuleDataSource {
  resolveAccountId(identity: CliDeviceIdentity): Promise<CapsuleDataResult<string | null>>;
  loadActiveDevice(accountId: string, deviceId: string): Promise<CapsuleDataResult<CapsuleDevice | null>>;
  authorizeCapsuleRead(
    accountId: string,
    deviceId: string,
  ): Promise<CapsuleDataResult<boolean | null>>;
  claimRequestNonce(
    accountId: string,
    deviceId: string,
    nonce: string,
    requestTimestamp: string,
  ): Promise<CapsuleDataResult<boolean | null>>;
  reserveCapsule(
    accountId: string,
    actorDeviceId: string,
    input: CapsuleReservationInput,
  ): Promise<CapsuleDataResult<CapsuleReservationResult | null>>;
  finalizeCapsule(
    accountId: string,
    actorDeviceId: string,
    capsuleId: string,
    serializedBytes: number,
    serializedSha256: string,
  ): Promise<CapsuleDataResult<CapsuleRow | null>>;
  listCapsules(accountId: string): Promise<CapsuleDataResult<CapsuleRow[] | null>>;
  inspectCapsule(accountId: string, capsuleId: string): Promise<CapsuleDataResult<CapsuleRow | null>>;
  createDownload(
    accountId: string,
    capsuleId: string,
  ): Promise<CapsuleDataResult<CapsuleDownloadResult | null>>;
  deleteCapsule(
    accountId: string,
    actorDeviceId: string,
    capsuleId: string,
  ): Promise<CapsuleDataResult<CapsuleRow | null>>;
  expireReservations(limit?: number): Promise<CapsuleDataResult<CapsuleRow[] | null>>;
  expireRequestNonces(limit?: number): Promise<CapsuleDataResult<number | null>>;
}

export class CapsuleDataConfigurationError extends Error {
  constructor(public readonly detail: string) {
    super("Capsule service is unavailable");
    this.name = "CapsuleDataConfigurationError";
  }
}

interface RawCapsuleRow extends Omit<CapsuleRow, "recipient_fingerprints"> {}

interface RawRecipientRow {
  capsule_id: string;
  recipient_fingerprint: string;
}

const CAPSULE_COLUMNS = [
  "account_id",
  "capsule_id",
  "object_path",
  "serialized_bytes",
  "serialized_sha256",
  "outer_schema",
  "payload_schema",
  "transfer_schema",
  "sender_fingerprint",
  "recipient_count",
  "status",
  "reserved_at",
  "reservation_refreshed_at",
  "reservation_expires_at",
  "finalized_at",
  "deletion_requested_at",
  "storage_deleted_at",
  "expiry_requested_at",
  "storage_cleanup_completed_at",
  "expired_at",
].join(",");

function first<T>(data: T | T[] | null): T | null {
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

function failure<T>(error: { message: string; code?: string } | null | undefined): CapsuleDataResult<T> {
  return {
    data: null as T,
    error: {
      message: error?.message ?? "Capsule data operation failed",
      ...(error?.code ? { code: error.code } : {}),
    },
  };
}

function storageObjectMissing(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return value.status === 404
    || value.statusCode === "404"
    || value.code === "NoSuchKey"
    || value.code === "not_found"
    || value.code === "object_not_found";
}

async function removeStoredObject(
  client: SupabaseClient,
  objectPath: string,
): Promise<CapsuleDataResult<true | null>> {
  const removed = await client.storage.from(CAPSULE_BUCKET).remove([objectPath]);
  if (!removed.error || storageObjectMissing(removed.error)) return { data: true, error: null };
  return failure({ code: "CAPSULE_STORAGE_REMOVE_FAILED", message: "Stored object removal failed" });
}

function capsuleRow(raw: RawCapsuleRow, recipients: string[]): CapsuleRow {
  return { ...raw, recipient_fingerprints: [...recipients].sort() };
}

async function verifyStoredObject(
  client: SupabaseClient,
  objectPath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<CapsuleDataResult<true | null>> {
  const metadata = await client.storage.from(CAPSULE_BUCKET).info(objectPath);
  if (metadata.error) {
    return storageObjectMissing(metadata.error)
      ? failure({ code: "CAPSULE_OBJECT_NOT_FOUND", message: "Stored object was not uploaded" })
      : failure({ code: "CAPSULE_OBJECT_STAT_FAILED", message: "Stored object metadata could not be read" });
  }
  if (metadata.data.size !== expectedBytes || expectedBytes < 1 || expectedBytes > 64 * 1024 * 1024) {
    return failure({ code: "CAPSULE_OBJECT_SIZE_MISMATCH", message: "Stored object size mismatch" });
  }

  const downloaded = await client.storage.from(CAPSULE_BUCKET).download(objectPath);
  if (downloaded.error) {
    return storageObjectMissing(downloaded.error)
      ? failure({ code: "CAPSULE_OBJECT_NOT_FOUND", message: "Stored object was not uploaded" })
      : failure({ code: "CAPSULE_OBJECT_READ_FAILED", message: "Stored object could not be read" });
  }
  const object = downloaded.data;
  if (!object || typeof object.size !== "number" || object.size !== expectedBytes || typeof object.stream !== "function") {
    return failure({ code: "CAPSULE_OBJECT_SIZE_MISMATCH", message: "Downloaded object size mismatch" });
  }

  const hash = createHash("sha256");
  let bytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    reader = object.stream().getReader() as ReadableStreamDefaultReader<Uint8Array>;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        return failure({ code: "CAPSULE_OBJECT_READ_FAILED", message: "Stored object stream was invalid" });
      }
      bytes += result.value.byteLength;
      if (bytes > expectedBytes || bytes > 64 * 1024 * 1024) {
        await reader.cancel();
        return failure({ code: "CAPSULE_OBJECT_SIZE_MISMATCH", message: "Stored object stream exceeded its bound" });
      }
      hash.update(result.value);
    }
  } catch {
    return failure({ code: "CAPSULE_OBJECT_READ_FAILED", message: "Stored object stream failed" });
  } finally {
    reader?.releaseLock();
  }

  if (bytes !== expectedBytes) {
    return failure({ code: "CAPSULE_OBJECT_SIZE_MISMATCH", message: "Stored object stream ended at the wrong size" });
  }
  if (hash.digest("hex") !== expectedSha256) {
    return failure({ code: "CAPSULE_OBJECT_HASH_MISMATCH", message: "Stored object hash mismatch" });
  }
  return { data: true, error: null };
}

async function recipientsFor(
  client: SupabaseClient,
  accountId: string,
  capsuleIds: string[],
): Promise<CapsuleDataResult<Map<string, string[]> | null>> {
  const result = new Map<string, string[]>();
  for (const id of capsuleIds) result.set(id, []);
  if (capsuleIds.length === 0) return { data: result, error: null };

  const response = await client
    .from(CAPSULE_DATABASE.recipientsTable)
    .select("capsule_id,recipient_fingerprint")
    .eq("account_id", accountId)
    .in("capsule_id", capsuleIds)
    .order("recipient_fingerprint", { ascending: true });
  if (response.error) return failure(response.error);
  for (const row of (response.data ?? []) as RawRecipientRow[]) {
    result.get(row.capsule_id)?.push(row.recipient_fingerprint);
  }
  return { data: result, error: null };
}

async function hydrateOne(
  client: SupabaseClient,
  accountId: string,
  raw: RawCapsuleRow | RawCapsuleRow[] | null,
): Promise<CapsuleDataResult<CapsuleRow | null>> {
  const selected = first(raw);
  if (!selected) return { data: null, error: null };
  const recipients = await recipientsFor(client, accountId, [selected.capsule_id]);
  if (recipients.error || !recipients.data) return failure(recipients.error);
  return { data: capsuleRow(selected, recipients.data.get(selected.capsule_id) ?? []), error: null };
}

async function hydrateMany(
  client: SupabaseClient,
  accountId: string,
  rows: RawCapsuleRow[] | null,
): Promise<CapsuleDataResult<CapsuleRow[] | null>> {
  const selected = rows ?? [];
  const recipients = await recipientsFor(client, accountId, selected.map((row) => row.capsule_id));
  if (recipients.error || !recipients.data) return failure(recipients.error);
  return {
    data: selected.map((row) => capsuleRow(row, recipients.data?.get(row.capsule_id) ?? [])),
    error: null,
  };
}

async function hydrateAcrossAccounts(
  client: SupabaseClient,
  rows: RawCapsuleRow[] | null,
): Promise<CapsuleDataResult<CapsuleRow[] | null>> {
  const selected = rows ?? [];
  const hydrated: CapsuleRow[] = [];
  for (const accountId of new Set(selected.map((row) => row.account_id))) {
    const accountRows = selected.filter((row) => row.account_id === accountId);
    const result = await hydrateMany(client, accountId, accountRows);
    if (result.error || !result.data) return failure(result.error);
    hydrated.push(...result.data);
  }
  return { data: hydrated, error: null };
}

export function createCapsuleSecretSupabaseClient(
  environment: NodeJS.ProcessEnv = process.env,
): SupabaseClient {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = environment.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new CapsuleDataConfigurationError("The Supabase URL or server-only secret key is not configured");
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "sinter-cloud-capsule-service" } },
  });
}

export function createCapsuleDataSource(
  client: SupabaseClient = createCapsuleSecretSupabaseClient(),
): CapsuleDataSource {
  const scopedCapsule = async (accountId: string, capsuleId: string) => {
    const response = await client
      .from(CAPSULE_DATABASE.capsulesTable)
      .select(CAPSULE_COLUMNS)
      .eq("account_id", accountId)
      .eq("capsule_id", capsuleId)
      .maybeSingle();
    if (response.error) return failure<CapsuleRow | null>(response.error);
    return hydrateOne(client, accountId, response.data as RawCapsuleRow | null);
  };

  return {
    resolveAccountId: async (identity) => {
      const response = await client
        .from(CAPSULE_DATABASE.accountIdentitiesTable)
        .select("account_id")
        .eq("issuer", identity.issuer)
        .eq("subject", identity.subject)
        .maybeSingle();
      return {
        data: response.data && typeof response.data.account_id === "string" ? response.data.account_id : null,
        error: response.error,
      };
    },

    loadActiveDevice: async (accountId, deviceId) => {
      const response = await client
        .from(CAPSULE_DATABASE.devicesTable)
        .select("id,user_id,fingerprint,signing_public_key")
        .eq("user_id", accountId)
        .eq("id", deviceId)
        .not("key_suite", "is", null)
        .not("approved_at", "is", null)
        .is("revoked_at", null)
        .maybeSingle();
      if (response.error) return failure(response.error);
      const row = response.data;
      if (!row || typeof row.fingerprint !== "string" || typeof row.signing_public_key !== "string") {
        return { data: null, error: null };
      }
      try {
        return {
          data: {
            id: row.id as string,
            account_id: row.user_id as string,
            fingerprint: row.fingerprint,
            signing_public_key: validatePublicP256Jwk(JSON.parse(row.signing_public_key), "signing"),
          },
          error: null,
        };
      } catch {
        return failure({ code: "CAPSULE_DEVICE_KEY_INVALID", message: "Stored device signing key is invalid" });
      }
    },

    authorizeCapsuleRead: async (accountId, deviceId) => {
      const authorized = await client.rpc(CAPSULE_DATABASE.authorizeReadRpc, {
        p_account_id: accountId,
        p_device_id: deviceId,
      });
      if (authorized.error) return failure(authorized.error);
      return { data: authorized.data === true, error: null };
    },

    claimRequestNonce: async (accountId, deviceId, nonce, requestTimestamp) => {
      const claimed = await client.rpc(CAPSULE_DATABASE.claimNonceRpc, {
        p_account_id: accountId,
        p_device_id: deviceId,
        p_nonce: nonce,
        p_request_timestamp: requestTimestamp,
      });
      if (claimed.error) return failure(claimed.error);
      return { data: claimed.data === true, error: null };
    },

    reserveCapsule: async (accountId, actorDeviceId, input) => {
      const reserved = await client.rpc(CAPSULE_DATABASE.reserveRpc, {
        p_account_id: accountId,
        p_actor_device_id: actorDeviceId,
        p_capsule_id: input.capsuleId,
        p_serialized_bytes: input.serializedBytes,
        p_serialized_sha256: input.serializedSha256,
        p_outer_schema: input.outerSchema,
        p_payload_schema: input.payloadSchema,
        p_transfer_schema: input.transferSchema,
        p_sender_fingerprint: input.senderFingerprint,
        p_recipient_fingerprints: input.recipientFingerprints,
      });
      if (reserved.error) return failure(reserved.error);
      const hydrated = await hydrateOne(
        client,
        accountId,
        reserved.data as RawCapsuleRow | RawCapsuleRow[] | null,
      );
      if (hydrated.error || !hydrated.data) return failure(hydrated.error);
      const upload = await client.storage
        .from(CAPSULE_BUCKET)
        .createSignedUploadUrl(hydrated.data.object_path, { upsert: false });
      if (upload.error || !upload.data?.signedUrl) return failure(upload.error);
      return {
        data: { capsule: hydrated.data, signedUploadUrl: upload.data.signedUrl },
        error: null,
      };
    },

    finalizeCapsule: async (accountId, actorDeviceId, capsuleId, serializedBytes, serializedSha256) => {
      const loaded = await scopedCapsule(accountId, capsuleId);
      if (loaded.error || !loaded.data) return loaded;
      if (
        loaded.data.serialized_bytes !== serializedBytes
        || loaded.data.serialized_sha256 !== serializedSha256
      ) {
        return failure({ code: "CAPSULE_FINALIZE_MISMATCH", message: "Finalize metadata mismatch" });
      }
      const verified = await verifyStoredObject(
        client,
        loaded.data.object_path,
        serializedBytes,
        serializedSha256,
      );
      if (verified.error) return failure(verified.error);
      const finalized = await client.rpc(CAPSULE_DATABASE.finalizeRpc, {
        p_account_id: accountId,
        p_actor_device_id: actorDeviceId,
        p_capsule_id: capsuleId,
        p_serialized_bytes: serializedBytes,
        p_serialized_sha256: serializedSha256,
      });
      if (finalized.error) return failure(finalized.error);
      return hydrateOne(client, accountId, finalized.data as RawCapsuleRow | RawCapsuleRow[] | null);
    },

    listCapsules: async (accountId) => {
      const response = await client
        .from(CAPSULE_DATABASE.capsulesTable)
        .select(CAPSULE_COLUMNS)
        .eq("account_id", accountId)
        .eq("status", "retained")
        .order("finalized_at", { ascending: false })
        .order("capsule_id", { ascending: true });
      if (response.error) return failure(response.error);
      return hydrateMany(client, accountId, response.data as unknown as RawCapsuleRow[] | null);
    },

    inspectCapsule: scopedCapsule,

    createDownload: async (accountId, capsuleId) => {
      const loaded = await scopedCapsule(accountId, capsuleId);
      if (loaded.error || !loaded.data) return loaded as CapsuleDataResult<CapsuleDownloadResult | null>;
      if (loaded.data.status !== "retained") {
        return failure({ code: "CAPSULE_NOT_DOWNLOADABLE", message: "Capsule is not retained" });
      }
      const expiresInSeconds = 60;
      const signed = await client.storage
        .from(CAPSULE_BUCKET)
        .createSignedUrl(loaded.data.object_path, expiresInSeconds, { download: true });
      if (signed.error) {
        return storageObjectMissing(signed.error)
          ? failure({ code: "CAPSULE_OBJECT_NOT_FOUND", message: "Stored object was not found" })
          : failure({ code: "CAPSULE_DOWNLOAD_URL_FAILED", message: "Download URL could not be created" });
      }
      if (!signed.data?.signedUrl) {
        return failure({ code: "CAPSULE_DOWNLOAD_URL_FAILED", message: "Download URL could not be created" });
      }
      return {
        data: { capsule: loaded.data, signedDownloadUrl: signed.data.signedUrl, expiresInSeconds },
        error: null,
      };
    },

    deleteCapsule: async (accountId, actorDeviceId, capsuleId) => {
      const begun = await client.rpc(CAPSULE_DATABASE.beginDeleteRpc, {
        p_account_id: accountId,
        p_actor_device_id: actorDeviceId,
        p_capsule_id: capsuleId,
      });
      if (begun.error) return failure(begun.error);
      const pending = await hydrateOne(
        client,
        accountId,
        begun.data as RawCapsuleRow | RawCapsuleRow[] | null,
      );
      if (pending.error || !pending.data) return pending;
      if (pending.data.status === "deleted") return pending;

      const removed = await removeStoredObject(client, pending.data.object_path);
      if (removed.error) return failure(removed.error);
      const finalized = await client.rpc(CAPSULE_DATABASE.finalizeDeleteRpc, {
        p_account_id: accountId,
        p_actor_device_id: actorDeviceId,
        p_capsule_id: capsuleId,
        p_serialized_bytes: pending.data.serialized_bytes,
        p_serialized_sha256: pending.data.serialized_sha256,
      });
      if (finalized.error) return failure(finalized.error);
      return hydrateOne(client, accountId, finalized.data as RawCapsuleRow | RawCapsuleRow[] | null);
    },

    expireReservations: async (limit = 100) => {
      const pending = await client.rpc(CAPSULE_DATABASE.expireRpc, { p_limit: limit });
      if (pending.error) return failure(pending.error);
      const hydrated = await hydrateAcrossAccounts(
        client,
        pending.data as unknown as RawCapsuleRow[] | null,
      );
      if (hydrated.error || !hydrated.data) return hydrated;

      const completed: CapsuleRow[] = [];
      let firstError: CapsuleDataError | null = null;
      for (const capsule of hydrated.data) {
        const removed = await removeStoredObject(client, capsule.object_path);
        if (removed.error) {
          firstError ??= removed.error;
          continue;
        }
        const finalized = await client.rpc(CAPSULE_DATABASE.finalizeExpiryRpc, {
          p_account_id: capsule.account_id,
          p_capsule_id: capsule.capsule_id,
          p_serialized_bytes: capsule.serialized_bytes,
          p_serialized_sha256: capsule.serialized_sha256,
        });
        if (finalized.error) {
          firstError ??= finalized.error;
          continue;
        }
        const result = await hydrateOne(
          client,
          capsule.account_id,
          finalized.data as RawCapsuleRow | RawCapsuleRow[] | null,
        );
        if (result.error || !result.data) {
          firstError ??= result.error ?? { message: "Expiry finalization returned no capsule" };
          continue;
        }
        completed.push(result.data);
      }
      if (firstError) return { data: completed, error: firstError };
      return { data: completed, error: null };
    },

    expireRequestNonces: async (limit = 1000) => {
      const expired = await client.rpc(CAPSULE_DATABASE.expireNoncesRpc, { p_limit: limit });
      if (expired.error) return failure(expired.error);
      return {
        data: typeof expired.data === "number" ? expired.data : null,
        error: null,
      };
    },
  };
}
