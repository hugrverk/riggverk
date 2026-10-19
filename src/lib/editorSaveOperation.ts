/** Monotonic save-operation tokens for editor channels. */
export function createSaveOperationTracker() {
  let sequence = 0;
  return {
    invalidate(): void {
      sequence += 1;
    },
    capture(): number {
      sequence += 1;
      return sequence;
    },
    isCurrent(operationId: number): boolean {
      return sequence === operationId;
    },
  };
}
