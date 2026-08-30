import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { cloudReleaseViolations, verifyCloudFreePackage } from "../scripts/verify-cloud-free";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("Cloud-free public package gate", () => {
  test("accepts the current public source and rejects Cloud command wiring", () => {
    expect(verifyCloudFreePackage("source", packageRoot)).toEqual([]);
    expect(cloudReleaseViolations({ "main.ts": 'import { cmdLogin } from "./commands"' }, "source"))
      .toEqual(["main.ts: cmdLogin"]);
    expect(cloudReleaseViolations({ "commands.ts": 'import x from "./cloud-auth"' }, "source"))
      .toEqual(['commands.ts: from "./cloud-auth"']);
  });

  test("rejects hosted Cloud markers in built output", () => {
    expect(cloudReleaseViolations({ "main.js": "https://sinter-cloud.example/api/cli/session" }, "dist"))
      .toEqual([
        "main.js: /api/cli/",
        "main.js: sinter-cloud.",
      ]);
  });
});
