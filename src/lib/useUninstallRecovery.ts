import { useCallback, useState } from "react";
import type { SetupResult } from "../types";

export function useUninstallRecovery() {
  const [transactionId, setTransactionId] = useState<string | null>(null);

  const captureFromUninstallResult = useCallback((result: SetupResult | null) => {
    // Failed or no-op runs return a transaction id without a persisted backup, which cannot be rolled back.
    if (result?.success && result.applied.length > 0 && result.transaction_id) {
      setTransactionId(result.transaction_id);
    }
  }, []);

  const clearRecovery = useCallback(() => {
    setTransactionId(null);
  }, []);

  return {
    transactionId,
    captureFromUninstallResult,
    clearRecovery,
  };
}
