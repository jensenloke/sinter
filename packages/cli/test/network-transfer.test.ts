import { afterEach, describe, expect, test } from "bun:test";
import {
  createTransferLocator,
  parseTransferLocator,
  sendTransfer,
  startTransferReceiver,
  type TransferReceiver,
} from "../src/network";

const receivers: TransferReceiver[] = [];

afterEach(() => {
  for (const receiver of receivers.splice(0)) receiver.close();
});

function receiver(options: Parameters<typeof startTransferReceiver>[0] = {}): TransferReceiver {
  const value = startTransferReceiver({ bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", ...options });
  receivers.push(value);
  return value;
}

describe("direct network transfer", () => {
  test("locator carries a 192-bit one-use capability and explicit address", () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const encoded = createTransferLocator({ host: "100.90.80.70", port: 4040, expiresAt });
    const parsed = parseTransferLocator(encoded);
    expect(parsed.version).toBe(1);
    expect(parsed.host).toBe("100.90.80.70");
    expect(parsed.port).toBe(4040);
    expect(parsed.capability.byteLength).toBe(24);
    expect(parsed.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  test("rejects expired and malformed locators", () => {
    expect(() => createTransferLocator({ host: "localhost", port: 4040, expiresAt: new Date(), capability: new Uint8Array(23) })).toThrow("192 bits");
    const expired = createTransferLocator({ host: "localhost", port: 4040, expiresAt: new Date(Date.now() - 1) });
    expect(() => parseTransferLocator(expired)).toThrow("expired");
    expect(() => parseTransferLocator("sinter://transfer/v2?host=x&port=1&token=x&expires=1")).toThrow("Unsupported");
  });

  test("sends opaque bytes with authenticated metadata and receipt", async () => {
    const target = receiver();
    const payload = crypto.getRandomValues(new Uint8Array(2048));
    const sent = await sendTransfer(target.locator, payload, { metadata: { harness: "claude", instance: "addvita" } });
    const received = await target.received;
    expect(received.transferId).toBe(sent.transferId);
    expect(received.bytes).toEqual(payload);
    expect(received.metadata).toEqual({ harness: "claude", instance: "addvita" });
    expect(received.remoteAddress).toBe("127.0.0.1");
  });

  test("rejects replay after a successful claim", async () => {
    const target = receiver();
    await sendTransfer(target.locator, new Uint8Array([1, 2, 3]));
    await target.received;
    await expect(sendTransfer(target.locator, new Uint8Array([4]))).rejects.toThrow("already_claimed");
  });

  test("accepts exactly one of two concurrent claims", async () => {
    const target = receiver();
    const attempts = await Promise.allSettled([
      sendTransfer(target.locator, new Uint8Array([1])),
      sendTransfer(target.locator, new Uint8Array([2])),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect([1, 2]).toContain((await target.received).bytes[0]);
  });

  test("wrong capability cannot claim the receiver", async () => {
    const target = receiver();
    const parsed = parseTransferLocator(target.locator);
    const wrong = createTransferLocator({
      host: parsed.host,
      port: parsed.port,
      expiresAt: parsed.expiresAt,
      capability: crypto.getRandomValues(new Uint8Array(24)),
    });
    await expect(sendTransfer(wrong, new Uint8Array([9]))).rejects.toThrow("unauthorized");

    await sendTransfer(target.locator, new Uint8Array([7]));
    expect((await target.received).bytes).toEqual(new Uint8Array([7]));
  });

  test("tampered ciphertext does not authenticate", async () => {
    const target = receiver();
    const tamperingFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      body[0] ^= 0xff;
      return fetch(input, { ...init, body: new Blob([body]) });
    };
    await expect(sendTransfer(target.locator, new Uint8Array([1, 2, 3]), { fetch: tamperingFetch })).rejects.toThrow("unauthorized");

    await sendTransfer(target.locator, new Uint8Array([5]));
    expect((await target.received).bytes[0]).toBe(5);
  });

  test("tampered authenticated metadata does not claim the receiver", async () => {
    const target = receiver();
    const tamperingFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const encoded = headers.get("x-sinter-metadata")!;
      headers.set("x-sinter-metadata", `${encoded.startsWith("A") ? "B" : "A"}${encoded.slice(1)}`);
      return fetch(input, { ...init, headers });
    };
    await expect(sendTransfer(target.locator, new Uint8Array([1]), { metadata: { target: "claude@addvita" }, fetch: tamperingFetch })).rejects.toThrow("unauthorized");

    await sendTransfer(target.locator, new Uint8Array([6]));
    expect((await target.received).bytes[0]).toBe(6);
  });

  test("enforces expiry, content type, and ciphertext size", async () => {
    const target = receiver({ ttlMs: 30, maxBytes: 2 });
    await expect(sendTransfer(target.locator, new Uint8Array([1, 2, 3]))).rejects.toThrow("payload_too_large");

    const parsed = parseTransferLocator(target.locator);
    const response = await fetch(`http://${parsed.host}:${parsed.port}/v1/transfers`, {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "16" },
      body: new Uint8Array(16),
    });
    expect(response.status).toBe(415);

    await Bun.sleep(35);
    expect(() => parseTransferLocator(target.locator)).toThrow("expired");
    await expect(target.received).rejects.toThrow("expired");
  });

  test("detects a forged receipt", async () => {
    const target = receiver();
    const forgingFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      const receipt = await response.json() as Record<string, unknown>;
      receipt.receipt = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      return Response.json(receipt, { status: response.status, headers: { "content-type": "application/vnd.sinter.receipt.v1+json" } });
    };
    await expect(sendTransfer(target.locator, new Uint8Array([1]), { fetch: forgingFetch })).rejects.toThrow("authenticated receipt");
  });
});
