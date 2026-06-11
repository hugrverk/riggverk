import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HarnessActionCard } from "./HarnessActionCard";
import {
  HARNESS_SURFACES,
  installationChipLabel,
  installationChipTone,
  installationPrimaryAction,
} from "../lib/harnessInstallation";
import type { InstallationStatus, InstallAgent } from "../types";

export interface HarnessInstallationCardProps {
  harness: InstallAgent;
  title: string;
  description: string;
  workspaceValid: boolean;
  busy: boolean;
  onUpdate: (surfaces: string[], label: string) => void;
}

export function HarnessInstallationCard({
  harness,
  title,
  description,
  workspaceValid,
  busy,
  onUpdate,
}: HarnessInstallationCardProps) {
  const [status, setStatus] = useState<InstallationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const genRef = useRef(0);

  const surfaces = HARNESS_SURFACES[harness];

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

  useEffect(() => { refresh(); }, [refresh]);

  if (!workspaceValid) return null;

  const chip = status
    ? { label: installationChipLabel(status.state), tone: installationChipTone(status.state) }
    : { label: loading ? "loading" : "unknown", tone: "muted" as const };

  const primary = status
    ? installationPrimaryAction(status.state)
    : { label: "update", variant: "primary" as const, disabled: true };

  const details = status ? [
    { label: "Summary", value: status.summary, tone: "muted" as const },
    ...(status.counts.remove_count > 0 ? [{
      label: "Removals",
      value: String(status.counts.remove_count),
      tone: "warn" as const,
    }] : []),
    ...(status.counts.conflict_count > 0 ? [{
      label: "Conflicts",
      value: String(status.counts.conflict_count),
      tone: "fail" as const,
    }] : []),
  ] : undefined;

  return (
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
        onClick: () => onUpdate(surfaces, `${title.toLowerCase()} update`),
      }}
      secondaryActions={[
        { label: "refresh status", onClick: refresh, disabled: busy || loading },
      ]}
    />
  );
}
