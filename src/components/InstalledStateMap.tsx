import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { installationChipTone } from "../lib/harnessInstallation";
import type { InstallationStatus, SurfaceInstallationStatus } from "../types";

interface HarnessGroup {
  label: string;
  surfaces: string[];
}

const GROUPS: HarnessGroup[] = [
  { label: "workspace", surfaces: ["workspace_bundle"] },
  { label: "codex", surfaces: ["codex_rules", "codex_agents", "codex_config", "codex_skills"] },
  {
    label: "opencode",
    surfaces: ["open_code_rules", "open_code_agents", "open_code_config", "open_code_skills"],
  },
  { label: "claude", surfaces: ["claude_rules", "claude_agents", "claude_skills"] },
  { label: "cursor", surfaces: ["cursor_agents", "cursor_skills", "cursor_mcp"] },
];

function shortSurfaceLabel(surface: SurfaceInstallationStatus): string {
  const tail = surface.label.split(" ").pop() ?? surface.label;
  return tail.toLowerCase();
}

interface InstalledStateMapProps {
  workspaceValid: boolean;
  busy: boolean;
  /** Bump to refresh, e.g. when an action completes. */
  refreshToken: number | null;
}

export function InstalledStateMap({ workspaceValid, busy, refreshToken }: InstalledStateMapProps) {
  const [surfaces, setSurfaces] = useState<Map<string, SurfaceInstallationStatus> | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const genRef = useRef(0);
  const prevStatesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!workspaceValid || busy) return;
    const gen = ++genRef.current;
    invoke<InstallationStatus>("get_installation_status", { surfaces: [] })
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
  }, [workspaceValid, busy, refreshToken]);

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
        {GROUPS.map((group, gi) => (
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
