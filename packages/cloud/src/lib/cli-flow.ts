import { createHmac, timingSafeEqual } from "node:crypto";

export const CLI_FLOW_COOKIE = "sinter_cli_flow";

export interface CliFlow {
  callback: string;
  state: string;
  createdAt: number;
}

function secret() {
  const value = process.env.SINTER_CLI_FLOW_SECRET;
  if (!value || value.length < 32) throw new Error("CLI login is not configured");
  return value;
}

function signature(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function validateLoopbackCallback(value: string) {
  const callback = new URL(value);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.pathname !== "/callback" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    !callback.port
  ) {
    throw new Error("CLI callback must be an explicit 127.0.0.1 loopback URL");
  }
  return callback.toString();
}

export function encodeCliFlow(flow: CliFlow) {
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function decodeCliFlow(value: string | undefined): CliFlow | undefined {
  if (!value) return undefined;
  const [payload, supplied, extra] = value.split(".");
  if (!payload || !supplied || extra) return undefined;
  const expected = signature(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<CliFlow>;
    if (
      typeof parsed.callback !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.createdAt !== "number" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(parsed.state) ||
      Date.now() - parsed.createdAt > 10 * 60 * 1000
    ) return undefined;
    return { callback: validateLoopbackCallback(parsed.callback), state: parsed.state, createdAt: parsed.createdAt };
  } catch {
    return undefined;
  }
}
