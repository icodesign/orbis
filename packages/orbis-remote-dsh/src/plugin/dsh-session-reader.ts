import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { SessionObservation } from "@deepseek-ai/dsh-session-query";
import { AgentBackendError } from "@orbisapp/orbis-agent-backend";

import type { DshSessionReader, DshSessionProjectionValues } from "../adapter/dsh-types";

function projectionValues(observation: SessionObservation): DshSessionProjectionValues {
  if (observation.projections === undefined) {
    throw new AgentBackendError("protocol", "DSH session projections are unavailable");
  }
  return observation.projections.values;
}

/** Read-only Orbis port; DSH's agent lifecycle retains all write ownership. */
export function createDshSessionReader(
  query: Context["sessionQuery"],
  persistence: Context["sessionPersistence"],
): DshSessionReader {
  return {
    async inspect(id, signal) {
      const observation = await query.observeSession(SessionId(String(id)), { signal });
      try {
        return {
          meta: observation.header,
          events: observation.events,
          projections: projectionValues(observation),
        };
      } finally {
        observation[Symbol.dispose]();
      }
    },
    async projections(id, signal) {
      const observation = await query.observeSession(SessionId(String(id)), { signal });
      try {
        return projectionValues(observation);
      } finally {
        observation[Symbol.dispose]();
      }
    },
    async list(signal) {
      return (await persistence.list({ signal })).map(({ header }) => header);
    },
  };
}
