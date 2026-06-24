import { useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HarnessActionCard } from "./HarnessActionCard";
import {
  HARNESS_SURFACES,
  installationChipLabel,
  installationChipTone,
  installationPrimaryAction,
} from "../lib/harnessInstallation";
import type { InstallationStatus, InstallAgent, SetupSurfaceId } from "../types";

export interface HarnessInstallationCardProps {
  harness?: InstallAgent;
  surfaces?: SetupSurfaceId[];
  title: string;
  description: string;
  workspaceValid: boolean;
  busy: boolean;
  onUpdate: (surfaces: string[], label: string) => void;
  path?: string;
  refreshKey?: number;
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

export function HarnessInstallationCard({
  harness,
  surfaces: explicitSurfaces,
  title,
  description,
  workspaceValid,
  busy,
  onUpdate,
  path,
  refreshKey,
  secondaryAction,
}: HarnessInstallationCardProps) {
  const [status, setStatus] = useState<InstallationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const genRef = useRef(0);
  const conflictDialogRef = useRef<HTMLDialogElement>(null);
  const conflictTitleId = useId();

  const surfaces = explicitSurfaces ?? (harness ? HARNESS_SURFACES[harness] : []);

  const refresh = useCallback(async () => {
    if (!workspaceValid) {
      setStatus(null);
      setError(null);
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<InstallationStatus>("get_installation_status", { surfaces });
      if (gen !== genRef.current) return;
      setStatus(next);
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [surfaces, workspaceValid]);

  useEffect(() => {
    if (!busy) refresh();
  }, [busy, refresh]);

  // External trigger to refresh status (e.g. after model save)
  useEffect(() => {
    if (!busy && workspaceValid) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (!workspaceValid) return null;

  const chip = status
    ? { label: installationChipLabel(status.state), tone: installationChipTone(status.state) }
    : { label: loading ? "loading" : "unknown", tone: "muted" as const };

  const primary = status
    ? installationPrimaryAction(status.state)
    : { label: "update", variant: "primary" as const, disabled: true };
  if (status?.state === "update_available" && status.counts.conflict_count > 0) {
    primary.label = "update safe files";
  }

  const details = status?.surfaces.map((s) => ({
    label: s.label.replace(/^(Codex|OpenCode|Claude|Cursor)\s+/, ""),
    value: s.detail,
    tone: installationChipTone(s.state),
  }));

  return (
    <>
    <HarnessActionCard
      title={title}
      ariaLabel={`${title} managed installation`}
      description={description}
      statusChip={chip}
      details={details}
      warning={error ?? undefined}
      primaryAction={{
        label: primary.label,
        variant: primary.variant,
        disabled: busy || loading || primary.disabled || !status,
        onClick: () => {
          if (status?.state === "conflict") {
            conflictDialogRef.current?.showModal();
            return;
          }
          onUpdate(surfaces, `${title.toLowerCase()} update`);
        },
      }}
      secondaryActions={[
        { label: "refresh status", onClick: refresh, disabled: busy || loading },
        ...(status?.conflict_details?.length && status.state !== "conflict"
          ? [{
              label: "review conflicts",
              onClick: () => conflictDialogRef.current?.showModal(),
              disabled: busy,
            }]
          : []),
        ...(secondaryAction ? [secondaryAction] : []),
      ]}
      nextAction={
        status?.conflict_details?.length
          ? `Preserved: ${status.conflict_details.join(", ")}`
          : status?.summary
      }
      nextActionTone={status?.conflict_details?.length ? "warn" : "ok"}
    />
    {path && <p className="ws-path-status-detail"><code>{path}</code></p>}
    <dialog ref={conflictDialogRef} aria-labelledby={conflictTitleId}>
      <div className="ws-panel">
        <h2 id={conflictTitleId}>Preserved conflicts</h2>
        <p>These files differ from proven app-owned content and were not changed.</p>
        <ul>
          {status?.conflict_details?.map((detail) => <li key={detail}>{detail}</li>)}
        </ul>
        <form method="dialog">
          <button className="btn btn-sm btn-primary" autoFocus>close</button>
        </form>
      </div>
    </dialog>
    </>
  );
}
