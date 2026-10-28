import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { postureRowsFor, POSTURE_UNAVAILABLE } from "../lib/securityPostureRows";
import { Kv } from "../ui/Kv";
import { toneClass } from "../ui/tone";
import type { InstallAgent, SecurityPosture } from "../types";

/** A usable answer: the mocks of other tests resolve `invoke` with nothing, and a failure must not break the page. */
function isPosture(value: unknown): value is SecurityPosture {
  const posture = value as SecurityPosture | null | undefined;
  return !!posture && typeof posture === "object" && Array.isArray(posture.sources) && Array.isArray(posture.findings);
}

/**
 * The `security` group of a harness page: which permission and sandbox settings the harness's global config sets
 * (`get_security_posture`, read-only). Read when the page opens and when `refreshKey` changes. It needs no workspace
 * folder: it reads the harness's own config, not the data folder.
 */
export function SecurityPostureRows({ harness, refreshKey }: { harness: InstallAgent; refreshKey: string }) {
  const [posture, setPosture] = useState<SecurityPosture | null>(null);
  const [failed, setFailed] = useState(false);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    const settle = (next: SecurityPosture | null) => {
      if (generation !== generationRef.current) return;
      setPosture(next);
      setFailed(next === null);
    };
    void Promise.resolve()
      .then(() => invoke<SecurityPosture>("get_security_posture", { harness }))
      .then(next => settle(isPosture(next) ? next : null), () => settle(null));
  }, [harness, refreshKey]);

  // The last answer stays while the next one loads, but never one for another harness.
  const shown = posture?.harness === harness ? posture : null;
  if (!shown && !failed) return null;
  const { verdict, rows } = shown ? postureRowsFor(shown) : { verdict: POSTURE_UNAVAILABLE, rows: [] };
  return (
    <>
      <div className="group">
        {"security · "}
        <span className={toneClass(verdict.tone) || undefined}>{verdict.text}</span>
      </div>
      {rows.length > 0 && <Kv items={rows} />}
    </>
  );
}
