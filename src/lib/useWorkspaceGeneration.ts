import { useCallback, useRef } from "react";

export function useWorkspaceGeneration() {
  const workspaceLoadGenerationRef = useRef(0);

  const isWorkspaceLoadCurrent = useCallback((generation: number) => {
    return workspaceLoadGenerationRef.current === generation;
  }, []);

  const beginWorkspaceLoadGeneration = useCallback((resetFn: () => void) => {
    workspaceLoadGenerationRef.current += 1;
    resetFn();
    return workspaceLoadGenerationRef.current;
  }, []);

  return { workspaceLoadGenerationRef, isWorkspaceLoadCurrent, beginWorkspaceLoadGeneration };
}
