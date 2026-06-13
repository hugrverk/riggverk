import { useCallback, useState } from "react";
import type { SetupResult } from "../types";

export function useUninstallRecovery() {
  const [transactionId, setTransactionId] = useState<string | null>(null);

  const captureFromUninstallResult = useCallback((result: SetupResult | null) => {
    if (result?.transaction_id) {
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
