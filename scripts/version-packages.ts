import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { versionPackages } from "./release-notes";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await versionPackages({
  workspaceRoot,
  runChangesetVersion: () => {
    execFileSync(
      process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["exec", "changeset", "version"],
      {
        cwd: workspaceRoot,
        stdio: "inherit",
      },
    );
  },
});
