export const REVIEWED_DSH_VERSION = "0.1.2-alpha.3" as const;

interface DshSessionSummary {
  readonly sessionId?: unknown;
  readonly projections?: {
    readonly values?: {
      readonly modelSelection?: {
        readonly next?: unknown;
      };
    };
  };
}

interface DshSessionListResult {
  readonly items?: readonly DshSessionSummary[];
}

/** Keep model observation fail-closed to the reviewed DSH projection contract. */
export function assertReviewedDshModelObservationContract(dshVersion: string): void {
  if (dshVersion !== REVIEWED_DSH_VERSION) {
    throw new Error(`DSH ${dshVersion} has no reviewed model-observation contract`);
  }
}

/** Read the model-selection projection from the selected DSH session summary. */
export function readDshModelObservation(
  sessions: DshSessionListResult,
  sessionId: string,
): unknown {
  const summary = sessions.items?.find((item) => item.sessionId === sessionId);
  if (summary === undefined) throw new Error("session/list did not include the selected Session");
  return summary.projections?.values?.modelSelection?.next ?? null;
}
