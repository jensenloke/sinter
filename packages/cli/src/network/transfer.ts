import { createTransferLocator, decodeBase64Url, encodeBase64Url, parseTransferLocator } from "./locator";
import { decryptPayload, deriveTransferKeys, digestTransfer, encryptPayload, signReceipt, signRequest, verifyReceipt, verifyRequest } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CONTENT_TYPE = "application/vnd.sinter.transfer.v1+octet-stream";
const RECEIPT_TYPE = "application/vnd.sinter.receipt.v1+json";
const PATH = "/v1/transfers";
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 4096;

export interface TransferMetadata {
  [key: string]: string;
}

interface WireMetadata {
  version: 1;
  transferId: string;
  createdAt: string;
  expiresAt: string;
  attributes: TransferMetadata;
}

export interface ReceivedTransfer {
  bytes: Uint8Array;
  metadata: TransferMetadata;
  transferId: string;
  receivedAt: Date;
  remoteAddress?: string;
}

export interface ReceiverOptions {
  bindHost?: string;
  advertiseHost?: string;
  port?: number;
  ttlMs?: number;
  maxBytes?: number;
  accept?: (transfer: ReceivedTransfer) => void | Promise<void>;
}

export interface TransferReceiver {
  locator: string;
  port: number;
  received: Promise<ReceivedTransfer>;
  close(): void;
}

export interface SendOptions {
  metadata?: TransferMetadata;
  timeoutMs?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function canonicalMetadata(value: WireMetadata): Uint8Array {
  const attributes: TransferMetadata = {};
  for (const key of Object.keys(value.attributes).sort()) {
    const item = value.attributes[key];
    if (typeof item !== "string") throw new Error("Transfer metadata values must be strings");
    attributes[key] = item;
  }
  const bytes = encoder.encode(JSON.stringify({
    version: value.version,
    transferId: value.transferId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    attributes,
  }));
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error("Transfer metadata is too large");
  return bytes;
}

function parseWireMetadata(bytes: Uint8Array): WireMetadata {
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error("Transfer metadata is too large");
  const parsed = JSON.parse(decoder.decode(bytes)) as Partial<WireMetadata>;
  if (parsed.version !== 1 || typeof parsed.transferId !== "string" || !parsed.transferId ||
      typeof parsed.createdAt !== "string" || typeof parsed.expiresAt !== "string" ||
      !parsed.attributes || typeof parsed.attributes !== "object" || Array.isArray(parsed.attributes)) {
    throw new Error("Invalid transfer metadata");
  }
  const canonical = canonicalMetadata(parsed as WireMetadata);
  if (encodeBase64Url(canonical) !== encodeBase64Url(bytes)) throw new Error("Transfer metadata is not canonical");
  if (!Number.isFinite(Date.parse(parsed.createdAt)) || !Number.isFinite(Date.parse(parsed.expiresAt))) {
    throw new Error("Invalid transfer timestamps");
  }
  return parsed as WireMetadata;
}

function requestUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${port}${PATH}`;
}

export function startTransferReceiver(options: ReceiverOptions = {}): TransferReceiver {
  const bindHost = options.bindHost ?? "127.0.0.1";
  const advertiseHost = options.advertiseHost ?? bindHost;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60 * 60_000) throw new Error("Receiver TTL must be between 1ms and 1 hour");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Receiver maximum size must be positive");

  const capability = crypto.getRandomValues(new Uint8Array(24));
  const expiresAt = new Date(Date.now() + ttlMs);
  let state: "open" | "claimed" | "expired" | "closed" = "open";
  let resolveReceived!: (value: ReceivedTransfer) => void;
  let rejectReceived!: (reason: Error) => void;
  const received = new Promise<ReceivedTransfer>((resolve, reject) => {
    resolveReceived = resolve;
    rejectReceived = reject;
  });
  // A caller may use only the HTTP surface; avoid an unhandled rejection on expiry.
  void received.catch(() => {});

  const server = Bun.serve({
    hostname: bindHost,
    port: options.port ?? 0,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname !== PATH) return jsonResponse({ error: "not_found" }, 404);
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST" });
      if (Date.now() >= expiresAt.getTime()) state = "expired";
      if (state !== "open") return jsonResponse({ error: state === "expired" ? "expired" : "already_claimed" }, 410);
      if (request.headers.get("content-type") !== CONTENT_TYPE) return jsonResponse({ error: "unsupported_content_type" }, 415);

      const length = Number(request.headers.get("content-length"));
      if (!Number.isInteger(length) || length < 16) return jsonResponse({ error: "length_required" }, 411);
      if (length > maxBytes + 16) return jsonResponse({ error: "payload_too_large" }, 413);

      let nonce: Uint8Array;
      let metadataBytes: Uint8Array;
      try {
        nonce = decodeBase64Url(request.headers.get("x-sinter-nonce") ?? "");
        metadataBytes = decodeBase64Url(request.headers.get("x-sinter-metadata") ?? "");
      } catch {
        return jsonResponse({ error: "invalid_envelope" }, 400);
      }
      if (nonce.byteLength !== 12 || metadataBytes.byteLength > MAX_METADATA_BYTES) return jsonResponse({ error: "invalid_envelope" }, 400);

      const ciphertext = new Uint8Array(await request.arrayBuffer());
      if (ciphertext.byteLength !== length) return jsonResponse({ error: "invalid_length" }, 400);
      if (Date.now() >= expiresAt.getTime()) {
        state = "expired";
        return jsonResponse({ error: "expired" }, 410);
      }
      const keys = await deriveTransferKeys(capability);
      const proof = request.headers.get("x-sinter-proof") ?? "";
      if (!(await verifyRequest(keys.requestAuthentication, proof, nonce, metadataBytes, ciphertext))) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }

      // Re-check after asynchronous authentication. Bun runs handlers concurrently, so this
      // is the compare-and-set boundary that prevents two valid requests being accepted.
      if (state !== "open") return jsonResponse({ error: "already_claimed" }, 410);
      if (Date.now() >= expiresAt.getTime()) {
        state = "expired";
        return jsonResponse({ error: "expired" }, 410);
      }
      // Claim before decrypting so even a malicious holder of the capability gets one attempt.
      state = "claimed";
      let metadata: WireMetadata;
      let bytes: Uint8Array;
      try {
        metadata = parseWireMetadata(metadataBytes);
        if (Date.parse(metadata.expiresAt) <= Date.now() || Date.parse(metadata.expiresAt) > expiresAt.getTime()) {
          throw new Error("Transfer metadata has expired");
        }
        bytes = await decryptPayload(ciphertext, nonce, metadataBytes, keys.encryption);
      } catch {
        return jsonResponse({ error: "invalid_envelope" }, 400);
      }
      const acceptedTransfer: ReceivedTransfer = {
        bytes,
        metadata: metadata.attributes,
        transferId: metadata.transferId,
        receivedAt: new Date(),
        remoteAddress: bunServer.requestIP(request)?.address,
      };
      try {
        await options.accept?.(acceptedTransfer);
      } catch {
        const error = new Error("Transfer was rejected by the receiver");
        rejectReceived(error);
        return jsonResponse({ error: "receiver_rejected_transfer" }, 422);
      }
      const digest = await digestTransfer(ciphertext);
      const receipt = await signReceipt(keys.receiptAuthentication, metadata.transferId, digest);
      resolveReceived(acceptedTransfer);
      return jsonResponse({ version: 1, transferId: metadata.transferId, digest: encodeBase64Url(digest), receipt }, 200, { "content-type": RECEIPT_TYPE });
    },
  });

  const timer = setTimeout(() => {
    if (state === "open") {
      state = "expired";
      rejectReceived(new Error("Transfer receiver expired"));
    }
  }, ttlMs);
  timer.unref?.();

  const boundPort = server.port;
  if (boundPort === undefined) {
    server.stop(true);
    throw new Error("Transfer receiver did not bind a TCP port");
  }
  const locator = createTransferLocator({ host: advertiseHost, port: boundPort, expiresAt, capability });
  return {
    locator,
    port: boundPort,
    received,
    close() {
      if (state === "open") {
        state = "closed";
        rejectReceived(new Error("Transfer receiver closed"));
      }
      clearTimeout(timer);
      server.stop(true);
    },
  };
}

export async function sendTransfer(locatorValue: string, payload: Uint8Array, options: SendOptions = {}): Promise<{ transferId: string }> {
  const locator = parseTransferLocator(locatorValue);
  const maxTimeout = locator.expiresAt.getTime() - Date.now();
  const timeoutMs = Math.min(options.timeoutMs ?? 30_000, maxTimeout);
  if (timeoutMs <= 0) throw new Error("Transfer locator has expired");

  const transferId = crypto.randomUUID();
  const metadataBytes = canonicalMetadata({
    version: 1,
    transferId,
    createdAt: new Date().toISOString(),
    expiresAt: locator.expiresAt.toISOString(),
    attributes: options.metadata ?? {},
  });
  const keys = await deriveTransferKeys(locator.capability);
  const { nonce, ciphertext } = await encryptPayload(payload, metadataBytes, keys.encryption);
  const proof = await signRequest(keys.requestAuthentication, nonce, metadataBytes, ciphertext);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(requestUrl(locator.host, locator.port), {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": CONTENT_TYPE,
      "content-length": String(ciphertext.byteLength),
      "x-sinter-nonce": encodeBase64Url(nonce),
      "x-sinter-metadata": encodeBase64Url(metadataBytes),
      "x-sinter-proof": proof,
    },
    body: new Blob([Uint8Array.from(ciphertext)]),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(`Transfer rejected: ${detail.error ?? `HTTP ${response.status}`}`);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0] !== RECEIPT_TYPE) throw new Error("Receiver returned an invalid receipt type");
  const receipt = await response.json() as { version?: number; transferId?: string; digest?: string; receipt?: string };
  const digest = await digestTransfer(ciphertext);
  if (receipt.version !== 1 || receipt.transferId !== transferId || receipt.digest !== encodeBase64Url(digest) ||
      typeof receipt.receipt !== "string" || !(await verifyReceipt(keys.receiptAuthentication, receipt.receipt, transferId, digest))) {
    throw new Error("Receiver returned an invalid authenticated receipt");
  }
  return { transferId };
}
