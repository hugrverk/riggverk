import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HarnessActionCard } from "./HarnessActionCard";
import type { InstallAgent, SkillSummary, SkillsSyncHealth } from "../types";

function groupSkills(skills: SkillSummary[]): Map<string, SkillSummary[]> {
  const groups = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    const label = skill.name === "wordpress-woocommerce"
      ? "Shared domain"
      : skill.group === "kretsverket"
        ? "Kretsverket"
        : "General";
    const bucket = groups.get(label) ?? [];
    bucket.push(skill);
    groups.set(label, bucket);
  }
  return groups;
}

interface TargetSkillsPanelProps {
  targetName: string;
  installAgents: InstallAgent[];
  skills: SkillSummary[];
  skillsLoaded: boolean;
  skillSearch: string;
  wsRunning: string | null;
  workspaceValid: boolean;
  onPreviewSync: () => void;
  onSyncAll: () => void;
  onPreviewRemoveDeprecated?: () => void;
  onRemoveDeprecated?: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function TargetSkillsPanel({
  targetName,
  installAgents,
  skills,
  skillsLoaded,
  skillSearch,
  wsRunning,
  workspaceValid,
  onPreviewSync,
  onSyncAll,
  onPreviewRemoveDeprecated,
  onRemoveDeprecated,
  onSetSkillSearch,
  onOpenInstallScript,
}: TargetSkillsPanelProps) {
  const [showSkillList, setShowSkillList] = useState(false);
  const [health, setHealth] = useState<SkillsSyncHealth | null>(null);
  const agent = installAgents[0];
  const skillsCount = skills.length;

  useEffect(() => {
    if (!workspaceValid || !agent || skillsCount === 0) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    invoke<SkillsSyncHealth>("get_skills_sync_health", { agent })
      .then(result => {
        if (!cancelled) setHealth(result);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceValid, agent, skillsCount, skills]);

  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return skills;
    const q = skillSearch.toLowerCase().trim();
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.group.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  }, [skills, skillSearch]);

  const grouped = useMemo(() => groupSkills(filteredSkills), [filteredSkills]);

  if (!workspaceValid) return null;

  const canSync = workspaceValid && skillsCount > 0;
  const statusTone: "ok" | "warn" | "fail" | "muted" = !health
    ? "muted"
    : health.missing_count === 0 && health.diverged_count === 0
      ? "ok"
      : health.synced_count > 0
        ? "warn"
        : "fail";

  const statusLabel = health
    ? `${health.synced_count}/${health.expected_count} synced`
    : `${skillsCount} bundled`;

  const deprecatedHint = health && (health.deprecated_identical_count > 0 || health.deprecated_diverged_count > 0)
    ? `${health.deprecated_identical_count} deprecated removable, ${health.deprecated_diverged_count} deprecated diverged`
    : null;

  const statusHint = !skillsLoaded
    ? "Loading skills…"
    : skills.length === 0
      ? "No skills in workspace."
      : health && (health.missing_count > 0 || health.diverged_count > 0)
        ? `${health.missing_count} missing, ${health.diverged_count} diverged${deprecatedHint ? `; ${deprecatedHint}` : ""}`
        : deprecatedHint ?? "Canonical bundled set installs to every enabled harness.";

  const hasRemovableDeprecated = (health?.deprecated_identical_count ?? 0) > 0;

  return (
    <HarnessActionCard
      title="Skills"
      ariaLabel={`${targetName} skills sync`}
      description={`Sync all ${skillsCount} bundled workspace skills for ${targetName}. Flat install layout; grouped source paths are visual only.`}
      statusChip={{ label: statusLabel, tone: statusTone }}
      warning={statusHint}
      secondaryActions={[
        { label: "preview sync", onClick: onPreviewSync, disabled: !canSync || wsRunning !== null },
        ...(onPreviewRemoveDeprecated && hasRemovableDeprecated ? [{
          label: "preview deprecated removal",
          onClick: onPreviewRemoveDeprecated,
          disabled: wsRunning !== null,
        }] : []),
        ...(onRemoveDeprecated && hasRemovableDeprecated ? [{
          label: "remove deprecated",
          onClick: onRemoveDeprecated,
          disabled: wsRunning !== null,
        }] : []),
        ...(skillsLoaded && skillsCount > 0 ? [{
          label: showSkillList ? "hide list" : "inspect skills",
          onClick: () => setShowSkillList(prev => !prev),
          disabled: wsRunning !== null,
        }] : []),
        { label: "open script", onClick: onOpenInstallScript, disabled: wsRunning !== null },
      ]}
      primaryAction={{
        label: "sync all skills",
        onClick: onSyncAll,
        disabled: !canSync || wsRunning !== null,
      }}
    >
      {showSkillList && (
        <div className="ws-skill-selector" role="region" aria-label="Bundled skills">
          <div className="ws-skill-selector-controls">
            <input
              className="skills-search"
              type="text"
              placeholder="search skills..."
              value={skillSearch}
              onChange={e => onSetSkillSearch(e.target.value)}
              aria-label="Search workspace skills"
            />
            {skillSearch && (
              <button
                type="button"
                className="btn btn-sm btn-clear-search"
                onClick={() => onSetSkillSearch("")}
                aria-label="Clear workspace skills search"
              >
                clear
              </button>
            )}
          </div>
          {Array.from(grouped.entries()).map(([section, items]) => (
            <div key={section} className="ws-skill-selector-group">
              <div className="ws-skill-selector-group-label">{section}</div>
              <div className="ws-skill-selector-list">
                {items.map(s => {
                  const entry = health?.skills.find(h => h.name === s.name);
                  const state = entry?.state ?? "unknown";
                  return (
                    <div key={s.id} className="ws-skill-selector-row">
                      <span className="ws-skill-selector-name">{s.name}</span>
                      <span className="ws-skill-selector-desc">{state}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </HarnessActionCard>
  );
}
