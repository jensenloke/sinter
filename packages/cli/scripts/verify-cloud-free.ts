import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type CloudFreeMode = "source" | "dist";

const SOURCE_MODULES = [
  "src/cloud-auth.ts",
  "src/cloud-devices.ts",
  "src/capsule-test.ts",
  "src/device-credentials.ts",
  "src/device-identity.ts",
];

const SOURCE_MARKERS = [
  'from "./cloud-auth"',
  'from "./cloud-devices"',
  'from "./capsule-test"',
  "cmdLogin",
  "cmdWhoami",
  "cmdLogout",
  "cmdDevices",
];

const DIST_MARKERS = [
  "sinter-cloud.vercel.app",
  "/api/cli/",
  "AUTH0_",
  "sinter login",
  "devices capsule-test",
  "sinter.cloud.identity.v1",
];

export function cloudReleaseViolations(files: Record<string, string>, mode: CloudFreeMode): string[] {
  const markers = mode === "source" ? SOURCE_MARKERS : DIST_MARKERS;
  const violations: string[] = [];
  for (const [path, content] of Object.entries(files))
    for (const marker of markers)
      if (content.includes(marker)) violations.push(`${path}: ${marker}`);
  return violations.sort();
}

function textFiles(root: string, extension: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && path.endsWith(extension)) files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

export function verifyCloudFreePackage(mode: CloudFreeMode, packageRoot: string): string[] {
  const violations: string[] = [];
  if (mode === "source") {
    for (const path of SOURCE_MODULES) if (existsSync(join(packageRoot, path))) violations.push(`${path}: forbidden Cloud module`);
    violations.push(...cloudReleaseViolations(textFiles(join(packageRoot, "src"), ".ts"), mode));
  } else {
    violations.push(...cloudReleaseViolations(textFiles(join(packageRoot, "dist"), ".js"), mode));
    if (!existsSync(join(packageRoot, "dist", "main.js"))) violations.push("dist/main.js: missing build output");
  }
  return violations.sort();
}

if (import.meta.main) {
  const mode = process.argv[2] as CloudFreeMode | undefined;
  if (mode !== "source" && mode !== "dist") {
    console.error("usage: bun run scripts/verify-cloud-free.ts <source|dist>");
    process.exit(1);
  }
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const violations = verifyCloudFreePackage(mode, packageRoot);
  if (violations.length) {
    console.error(`Refusing Cloud-enabled public package:\n${violations.map((item) => `  ${item}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`verified Cloud-free ${mode} package boundary`);
}
