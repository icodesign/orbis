import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";

import type { DshSessionPersistence } from "../adapter/dsh-types";

/** Read-only Orbis port; DSH's agent lifecycle retains all write ownership. */
export function createDshSessionPersistence(
  persistence: Context["sessionPersistence"],
): DshSessionPersistence {
  return {
    async inspect(id, signal) {
      const handle = await persistence.open(SessionId(String(id)), "read", { signal });
      try {
        const { events } = await handle.read(undefined, undefined, { signal });
        return { meta: handle.header, events };
      } finally {
        await handle.close();
      }
    },
    async list(signal) {
      return (await persistence.list({ signal })).map(({ header }) => header);
    },
  };
}
