/** Monotonic save-operation tokens for editor channels. */
export function createSaveOperationTracker() {
  let sequence = 0;
  return {
    invalidate(): void {
      sequence += 1;
    },
    capture(): number {
      return sequence;
    },
    isCurrent(operationId: number): boolean {
      return sequence === operationId;
    },
  };
}

export type SaveOperationTracker = ReturnType<typeof createSaveOperationTracker>;

export function shouldApplyOpenCodeSourceSave(
  activeTargetId: string,
  activeSourceType: string,
  draftIdentity: string | null,
  operationId: number,
  responseOperationId: number,
  responseSourceType: string,
): boolean {
  if (operationId !== responseOperationId) return false;
  if (activeTargetId !== "opencode_config") return false;
  if (activeSourceType !== responseSourceType) return false;
  return draftIdentity === `opencode_config:${responseSourceType}` || draftIdentity === null;
}
