import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HARNESS_LABELS, HARNESS_SURFACES, installationChipTone, WORKSPACE_SURFACES } from "../lib/harnessInstallation";
import type { InstallationStatus, InstallAgent, SurfaceInstallationStatus } from "../types";

interface HarnessGroup {
  label: string;
  surfaces: string[];
}

function shortSurfaceLabel(surface: SurfaceInstallationStatus): string {
  const tail = surface.label.split(" ").pop() ?? surface.label;
  return tail.toLowerCase();
}

interface InstalledStateMapProps {
  workspaceValid: boolean;
  busy: boolean;
  /** Bump to refresh, e.g. when an action completes. */
  refreshToken: number | null;
  enabledHarnessIds: InstallAgent[];
}

export function InstalledStateMap({ workspaceValid, busy, refreshToken, enabledHarnessIds }: InstalledStateMapProps) {
  const [surfaces, setSurfaces] = useState<Map<string, SurfaceInstallationStatus> | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const genRef = useRef(0);
  const prevStatesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!workspaceValid || busy) return;
    const gen = ++genRef.current;
    const requestedSurfaces = [
      ...WORKSPACE_SURFACES,
      ...enabledHarnessIds.flatMap(harness => HARNESS_SURFACES[harness]),
    ];
    invoke<InstallationStatus>("get_installation_status", { surfaces: requestedSurfaces })
      .then((status) => {
        if (gen !== genRef.current) return;
        const next = new Map<string, SurfaceInstallationStatus>();
        const flashes = new Set<string>();
        for (const s of status.surfaces) {
          const key = String(s.surface);
          next.set(key, s);
          const prev = prevStatesRef.current.get(key);
          if (prev !== undefined && prev !== s.state) flashes.add(key);
          prevStatesRef.current.set(key, s.state);
        }
        setSurfaces(next);
        if (flashes.size > 0) {
          setChanged(flashes);
          window.setTimeout(() => setChanged(new Set()), 1200);
        }
      })
      .catch(() => {
        if (gen === genRef.current) setSurfaces(null);
      });
  }, [workspaceValid, busy, refreshToken, enabledHarnessIds]);

  if (!workspaceValid) return null;

  return (
    <div
      className={`ws-section harness-action-card installed-map${busy ? " installed-map-busy" : ""}`}
      role="region"
      aria-label="Installed surfaces map"
    >
      <div className="ws-section-header">
        <span className="ws-section-title">Installed</span>
        <span className={`installed-map-beacon${busy ? " installed-map-beacon-busy" : ""}`} aria-hidden="true" />
      </div>
      <div className="installed-map-grid">
        {([
          { label: "workspace", surfaces: WORKSPACE_SURFACES },
          ...enabledHarnessIds.map(harness => ({
            label: HARNESS_LABELS[harness].toLowerCase(),
            surfaces: HARNESS_SURFACES[harness],
          })),
        ] as HarnessGroup[]).map((group, gi) => (
          <div key={group.label} className="installed-map-row">
            <span className="installed-map-row-label">{group.label}</span>
            <span className="installed-map-cells">
              {group.surfaces.map((id, ci) => {
                const s = surfaces?.get(id);
                const tone = s ? installationChipTone(s.state) : "muted";
                const flash = changed.has(id) ? " installed-map-cell-flash" : "";
                return (
                  <span
                    key={id}
                    className={`installed-map-cell installed-map-cell-${tone}${flash}`}
                    style={{ animationDelay: `${(gi * 4 + ci) * 60}ms` }}
                    title={s ? `${s.label}: ${s.detail}` : "loading"}
                  >
                    <span className="installed-map-dot" aria-hidden="true" />
                    {s ? shortSurfaceLabel(s) : "…"}
                  </span>
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
