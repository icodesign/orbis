import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";

import { en, zh, type OrbisLocaleKey } from "./locales";
import { OrbisSettingsSection, type OrbisSettingsSectionInjected } from "./OrbisSettingsSection";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    orbis: OrbisLocaleKey;
  }
}

const namespace = "orbis";

export const inject = ["slots", "locale"];

/** Adds the feature-owned Orbis page to DSH Web's Plugins section. */
export function apply(context: ClientContext): void {
  context.effect(
    () => context.locale.register(namespace, { zh, en }),
    "orbis-dsh-remote: dictionaries",
  );
  const translate = context.locale.bind(namespace) as OrbisSettingsSectionInjected["t"];
  const injected = (): OrbisSettingsSectionInjected => ({ t: translate });
  context.slots.inject("settings.plugins.tab", () =>
    context.slots.register(
      {
        name: "settings.plugins.tab",
        id: "orbis",
        order: 20,
        label: () => translate("nav"),
        inject: injected,
      },
      OrbisSettingsSection,
    ),
  );
}
