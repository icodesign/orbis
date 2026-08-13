import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "src");
const outputDirectory = resolve(packageDirectory, "dist");
const legacyOutputDirectory = resolve(packageDirectory, "lib");

const hostExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "ws",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/dsh-host-directory-picker",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-session-persistence",
  "@deepseek-ai/dsh-workspace",
];

const clientExternals = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-slots",
];

await Promise.all([
  rm(outputDirectory, { recursive: true, force: true }),
  rm(legacyOutputDirectory, { recursive: true, force: true }),
]);

try {
  await Promise.all([
    build({
      bundle: true,
      entryPoints: [resolve(sourceDirectory, "plugin", "dsh-plugin.ts")],
      external: hostExternals,
      format: "esm",
      platform: "node",
      sourcemap: "linked",
      target: "node22",
      tsconfig: resolve(packageDirectory, "tsconfig.json"),
      outfile: resolve(outputDirectory, "index.js"),
    }),
    build({
      banner: {
        js: 'window.__ModuleLoader__.load({ id: "@orbisapp/remote-dsh", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
      },
      bundle: true,
      define: {
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
      },
      entryPoints: [resolve(sourceDirectory, "client", "index.tsx")],
      external: clientExternals,
      footer: {
        js: "return module.exports; } });",
      },
      format: "cjs",
      outfile: resolve(outputDirectory, "client.js"),
      platform: "browser",
      sourcemap: "linked",
      target: "esnext",
      tsconfig: resolve(packageDirectory, "tsconfig.json"),
    }),
  ]);
} catch (error: unknown) {
  if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
    for (const diagnostic of error.errors) {
      console.error(diagnostic.text ?? diagnostic);
    }
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
