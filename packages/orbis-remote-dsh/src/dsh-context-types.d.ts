import type { DirectoryPicker } from "@deepseek-ai/dsh-host-directory-picker";
import type { WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";

/**
 * DSH profile services are injected at runtime and are not part of the
 * standalone package's public cordis dependency. Keep this declaration to the
 * narrow surface consumed by the Orbis host plugin.
 */
import type { OrbisHttpRoute } from "./plugin/http-api";

declare module "@deepseek-ai/cordis" {
  interface Context {
    credentials: unknown;
    directoryPicker: DirectoryPicker;
    effect(execute: () => unknown, label?: string): unknown;
    webServer: {
      host: string;
      register(route: OrbisHttpRoute): () => void;
    };
    sessionProjectionCache: unknown;
    workspaceRegistry: WorkspaceRegistry;
  }
}
