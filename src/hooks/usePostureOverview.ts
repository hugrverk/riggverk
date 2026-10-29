import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { InstallAgent, SecurityPosture } from "../types";

export type PostureOverview = Partial<Record<InstallAgent, SecurityPosture>>;

/** A usable answer: the mocks of other tests resolve `invoke` with nothing, and a failure must not break the page. */
function isPosture(value: unknown): value is SecurityPosture {
  const posture = value as SecurityPosture | null | undefined;
  return !!posture && typeof posture === "object" && Array.isArray(posture.sources) && Array.isArray(posture.findings);
}

/**
 * The security posture of every enabled agent (`get_security_posture`, read-only, one call per agent), for the
 * Overview's "Worth a look" cell. It reads each agent's own config, not the workspace folder, so it needs no folder.
 * Read when the set of agents or `refreshKey` changes; an agent whose read fails is left out. The first change of the
 * key away from 0 (the first completed check, right after the read on mount) is not a reason to read again. A generation
 * guard drops answers that arrive after a newer read started.
 */
export function usePostureOverview(harnesses: readonly InstallAgent[], refreshKey: string | number): PostureOverview {
  const [postures, setPostures] = useState<PostureOverview>({});
  const generationRef = useRef(0);
  const lastReadRef = useRef<{ harnessKey: string; refreshKey: string | number } | null>(null);
  const harnessKey = harnesses.join(",");

  useEffect(() => {
    const previous = lastReadRef.current;
    lastReadRef.current = { harnessKey, refreshKey };
    if (previous && previous.harnessKey === harnessKey && previous.refreshKey === 0 && refreshKey !== 0) return;
    const generation = ++generationRef.current;
    const ids = harnessKey ? (harnessKey.split(",") as InstallAgent[]) : [];
    void Promise.all(
      ids.map(async (harness): Promise<[InstallAgent, SecurityPosture | null]> => {
        try {
          const posture = await invoke<SecurityPosture>("get_security_posture", { harness });
          return [harness, isPosture(posture) && posture.harness === harness ? posture : null];
        } catch {
          return [harness, null];
        }
      }),
    ).then(results => {
      if (generation !== generationRef.current) return;
      const next: PostureOverview = {};
      for (const [harness, posture] of results) if (posture) next[harness] = posture;
      setPostures(next);
    });
  }, [harnessKey, refreshKey]);

  return postures;
}
