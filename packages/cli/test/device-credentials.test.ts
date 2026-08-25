import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDeviceCredentialStore, deviceCredentialPath } from "../src/device-credentials";
import { generateDeviceKeyMaterial } from "../src/device-identity";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("device key custody", () => {
  test("uses a distinct macOS Keychain service with no plaintext fallback", async () => {
    const keys = await generateDeviceKeyMaterial();
    const calls: string[][] = [];
    let saved = "";
    const store = createDeviceCredentialStore({
      os: "darwin",
      home: "/path-that-must-not-be-used",
      run: async (argv) => {
        calls.push(argv);
        if (argv[1] === "add-generic-password") saved = argv.at(-1)!;
        if (argv[1] === "find-generic-password") return { code: 0, stdout: saved, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await store.save(keys);
    expect(await store.load()).toEqual(keys);
    expect(calls.every((call) => call.includes("app.sinter.cloud.device-keys"))).toBe(true);
    expect(calls.map((call) => call[1])).toEqual(["add-generic-password", "find-generic-password"]);
    expect(store.description).toBe("macOS Keychain");
  });

  test("does not fall back when macOS Keychain saving fails", async () => {
    const keys = await generateDeviceKeyMaterial();
    const store = createDeviceCredentialStore({
      os: "darwin",
      home: "/path-that-must-not-be-used",
      run: async () => ({ code: 1, stdout: "", stderr: "locked" }),
    });
    await expect(store.save(keys)).rejects.toThrow(/Keychain/);
  });

  test("uses a separate owner-only file elsewhere and validates on load", async () => {
    const home = mkdtempSync(join(tmpdir(), "sinter-device-keys-"));
    temporary.push(home);
    const store = createDeviceCredentialStore({ os: "linux", home, env: {} });
    const keys = await generateDeviceKeyMaterial();
    await store.save(keys);
    const path = deviceCredentialPath({}, home);
    expect(path).toEndWith("cloud-device-keys.json");
    expect(path).not.toEndWith("cloud-auth.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(keys);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);

    writeFileSync(path, JSON.stringify({ ...keys, suite: "wrong-suite" }), { mode: 0o600 });
    await expect(store.load()).rejects.toThrow(/Invalid local device key credential/);
  });
});
