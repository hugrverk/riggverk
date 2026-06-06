import { useCallback, useRef } from "react";

/** Monotonic request tokens for a single resource channel (e.g. selected doc id). */
export function useResourceRequestGuard() {
  const seqRef = useRef(0);

  const beginRequest = useCallback(() => {
    seqRef.current += 1;
    return seqRef.current;
  }, []);

  const isCurrentRequest = useCallback((token: number) => {
    return seqRef.current === token;
  }, []);

  const invalidate = useCallback(() => {
    seqRef.current += 1;
  }, []);

  return { beginRequest, isCurrentRequest, invalidate };
}
