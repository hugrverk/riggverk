import { useCallback, useEffect, useRef, useState } from "react";

/** Short-lived status text with automatic clear and unmount cleanup. */
export function useTransientStatus(clearMs: number): {
  status: string | null;
  showStatus: (text: string) => void;
  clearStatus: () => void;
} {
  const [status, setStatus] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearStatus = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStatus(null);
  }, []);

  const showStatus = useCallback((text: string) => {
    setStatus(text);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setStatus(null);
    }, clearMs);
  }, [clearMs]);

  useEffect(() => () => clearStatus(), [clearStatus]);

  return { status, showStatus, clearStatus };
}
