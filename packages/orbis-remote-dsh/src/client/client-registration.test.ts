import { readFileSync } from "node:fs";

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import { expect, test, vi } from "vitest";

import { apply } from "./index";
import { OrbisSettingsSection } from "./OrbisSettingsSection";

test("declares the browser bundle through the current dsh.client manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const dsh = manifest.dsh as Record<string, unknown>;

  expect(manifest).not.toHaveProperty("dshClient");
  expect(dsh.client).toEqual({
    inject: [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-primitives",
      "@deepseek-ai/dsh-client-ui-settings",
    ],
    platform: "web",
  });
});

test("registers Orbis as a page inside the Plugins settings section", () => {
  interface RegistrationOptions {
    readonly id: string;
    readonly inject: () => unknown;
    readonly label: () => string;
    readonly name: string;
    readonly order: number;
  }
  const register = vi.fn<(options: RegistrationOptions, component: unknown) => () => undefined>(
    () => () => undefined,
  );
  const inject = vi.fn((_name: string, contribution: () => unknown) => contribution());
  const translate = (key: string): string => (key === "nav" ? "Orbis" : key);
  const context = {
    effect: (mount: () => unknown) => mount(),
    locale: {
      bind: () => translate,
      register: () => () => undefined,
    },
    slots: { inject, register },
  } as unknown as ClientContext;

  apply(context);

  expect(inject).toHaveBeenCalledWith("settings.plugins.tab", expect.any(Function));
  expect(register).toHaveBeenCalledTimes(1);
  const [options, component] = register.mock.calls[0]!;
  expect(options).toMatchObject({
    id: "orbis",
    name: "settings.plugins.tab",
    order: 20,
  });
  expect(options.label()).toBe("Orbis");
  expect(options.inject()).toEqual({ t: translate });
  expect(component).toBe(OrbisSettingsSection);
});
