const LOCATOR_PROTOCOL = "sinter:";
const LOCATOR_HOST = "transfer";
const LOCATOR_PATH = "/v1";
const CAPABILITY_BYTES = 24;

export interface TransferLocator {
  version: 1;
  host: string;
  port: number;
  capability: Uint8Array;
  expiresAt: Date;
}

export interface CreateLocatorOptions {
  host: string;
  port: number;
  expiresAt: Date;
  capability?: Uint8Array;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function createTransferLocator(options: CreateLocatorOptions): string {
  if (!options.host.trim()) throw new Error("An advertised host is required");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error("Transfer port must be between 1 and 65535");
  }
  if (!Number.isFinite(options.expiresAt.getTime())) throw new Error("Invalid locator expiry");

  const capability = options.capability ?? crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES));
  if (capability.byteLength !== CAPABILITY_BYTES) {
    throw new Error("Transfer capability must contain exactly 192 bits");
  }

  const url = new URL(`${LOCATOR_PROTOCOL}//${LOCATOR_HOST}${LOCATOR_PATH}`);
  url.searchParams.set("host", options.host);
  url.searchParams.set("port", String(options.port));
  url.searchParams.set("token", encodeBase64Url(capability));
  url.searchParams.set("expires", String(options.expiresAt.getTime()));
  return url.toString();
}

export function parseTransferLocator(value: string, now = new Date()): TransferLocator {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Sinter transfer locator");
  }
  if (url.protocol !== LOCATOR_PROTOCOL || url.hostname !== LOCATOR_HOST || url.pathname !== LOCATOR_PATH) {
    throw new Error("Unsupported Sinter transfer locator");
  }
  if (url.username || url.password || url.hash) throw new Error("Invalid Sinter transfer locator");

  const allowed = new Set(["host", "port", "token", "expires"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown transfer locator field: ${key}`);
  }
  const host = url.searchParams.get("host")?.trim() ?? "";
  const port = Number(url.searchParams.get("port"));
  const expires = Number(url.searchParams.get("expires"));
  const rawToken = url.searchParams.get("token") ?? "";
  if (!host || /[\s/?#]/.test(host)) throw new Error("Invalid advertised host");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid transfer port");
  if (!Number.isSafeInteger(expires)) throw new Error("Invalid transfer expiry");
  const capability = decodeBase64Url(rawToken);
  if (capability.byteLength !== CAPABILITY_BYTES) throw new Error("Invalid transfer capability");
  const expiresAt = new Date(expires);
  if (expiresAt.getTime() <= now.getTime()) throw new Error("Transfer locator has expired");

  return { version: 1, host, port, capability, expiresAt };
}

