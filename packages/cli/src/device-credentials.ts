import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { validateDeviceKeyMaterial, type DeviceKeyMaterial } from "./device-identity";

const DEVICE_KEYCHAIN_SERVICE = "app.sinter.cloud.device-keys";
const DEVICE_KEYCHAIN_ACCOUNT = "default";

interface CommandResult { code: number; stdout: string; stderr: string }
export type DeviceCredentialCommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface DeviceCredentialStore {
  readonly description: string;
  load(): Promise<DeviceKeyMaterial | undefined>;
  save(keys: DeviceKeyMaterial): Promise<void>;
  delete(): Promise<void>;
}

async function runCommand(argv: string[]): Promise<CommandResult> {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

export function deviceCredentialPath(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "sinter", "cloud-device-keys.json");
}

async function parseAndValidate(serialized: string): Promise<DeviceKeyMaterial> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Local device key credential is not valid JSON");
  }
  return validateDeviceKeyMaterial(parsed);
}

/** Device private keys use custody separate from account credentials and profile configuration. */
export function createDeviceCredentialStore(options: {
  os?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: DeviceCredentialCommandRunner;
} = {}): DeviceCredentialStore {
  const os = options.os ?? platform();
  const run = options.run ?? runCommand;

  if (os === "darwin") {
    return {
      description: "macOS Keychain",
      async load() {
        const result = await run([
          "security", "find-generic-password", "-a", DEVICE_KEYCHAIN_ACCOUNT,
          "-s", DEVICE_KEYCHAIN_SERVICE, "-w",
        ]);
        if (result.code !== 0) return undefined;
        return parseAndValidate(result.stdout);
      },
      async save(keys) {
        await validateDeviceKeyMaterial(keys);
        const result = await run([
          "security", "add-generic-password", "-U", "-a", DEVICE_KEYCHAIN_ACCOUNT,
          "-s", DEVICE_KEYCHAIN_SERVICE, "-w", JSON.stringify(keys),
        ]);
        if (result.code !== 0) {
          throw new Error(`Could not save device keys to Keychain: ${result.stderr.trim() || "security failed"}`);
        }
      },
      async delete() {
        await run([
          "security", "delete-generic-password", "-a", DEVICE_KEYCHAIN_ACCOUNT,
          "-s", DEVICE_KEYCHAIN_SERVICE,
        ]);
      },
    };
  }

  const path = deviceCredentialPath(options.env, options.home);
  return {
    description: `owner-only file ${path}`,
    async load() {
      try {
        return await parseAndValidate(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(keys) {
      await validateDeviceKeyMaterial(keys);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(keys), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      await chmod(path, 0o600);
    },
    async delete() {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
