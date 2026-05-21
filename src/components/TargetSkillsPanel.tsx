import { useState, useMemo } from "react";
import { HarnessActionCard } from "./HarnessActionCard";
import type { InstallAgent, SkillSummary } from "../types";

interface TargetSkillSelectorProps {
  skills: SkillSummary[];
  selectedSkills: Set<string>;
  skillSearch: string;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onSetSkillSearch: (value: string) => void;
}

export function TargetSkillSelector({
  skills,
  selectedSkills,
  skillSearch,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onSetSkillSearch,
}: TargetSkillSelectorProps) {
  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return skills;
    const q = skillSearch.toLowerCase().trim();
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  }, [skills, skillSearch]);

  return (
    <div className="ws-skill-selector" role="region" aria-label="Skill selection">
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
        <button type="button" className="btn btn-sm" onClick={onSelectAllSkills}>all</button>
        <button type="button" className="btn btn-sm" onClick={onClearSelectionSkills}>clear</button>
      </div>
      <div className="ws-skill-selector-list">
        {filteredSkills.length === 0 ? (
          <div className="ws-skill-selector-empty">
            {skillSearch ? "No matching skills" : "No skills found"}
          </div>
        ) : (
          filteredSkills.map(s => {
            const isSelected = selectedSkills.has(s.name);
            return (
              <div key={s.id} className={`ws-skill-selector-row ${isSelected ? "ws-skill-selector-row-on" : ""}`}>
                <button
                  type="button"
                  className={`skills-row-check-button ${isSelected ? "skills-row-check-button-on" : ""}`}
                  onClick={() => onToggleSkill(s.name)}
                  aria-pressed={isSelected}
                  aria-label={`${isSelected ? "Deselect" : "Select"} skill ${s.name}`}
                >
                  {isSelected ? "x" : ""}
                </button>
                <span className="ws-skill-selector-name">{s.name}</span>
                <span className="ws-skill-selector-desc">{s.description}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

interface TargetSkillsPanelProps {
  targetName: string;
  installAgents: InstallAgent[];
  skills: SkillSummary[];
  skillsLoaded: boolean;
  selectedSkills: Set<string>;
  skillSearch: string;
  wsRunning: string | null;
  workspaceValid: boolean;
  onDryRun: () => void;
  onInstall: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function TargetSkillsPanel({
  targetName,
  skills,
  skillsLoaded,
  selectedSkills,
  skillSearch,
  wsRunning,
  workspaceValid,
  onDryRun,
  onInstall,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onSetSkillSearch,
  onOpenInstallScript,
}: TargetSkillsPanelProps) {
  const [showSkillSelector, setShowSkillSelector] = useState(false);
  const skillsCount = skills.length;
  const selectedSkillsCount = selectedSkills.size;
  const skillsCanInstall = workspaceValid && selectedSkillsCount > 0;

  if (!workspaceValid) return null;

  const selectionTone: "ok" | "warn" | "muted" = selectedSkillsCount === skillsCount && skillsCount > 0
    ? "ok"
    : selectedSkillsCount > 0
      ? "warn"
      : "muted";

  const selectionHint = !skillsLoaded
    ? "Loading skills…"
    : skills.length === 0
      ? "No skills in workspace."
      : selectedSkillsCount === 0
        ? "Select skills to install."
        : undefined;

  return (
    <HarnessActionCard
      title="Skills"
      ariaLabel={`${targetName} skills install`}
      description={`Install selected workspace skills for ${targetName}. Uses install-skills.sh — does not sync rules or config.`}
      statusChip={skillsCount > 0
        ? { label: `${selectedSkillsCount}/${skillsCount}`, tone: selectionTone }
        : { label: "none", tone: "muted" }}
      warning={selectionHint}
      secondaryActions={[
        { label: "dry run", onClick: onDryRun, disabled: !skillsCanInstall || wsRunning !== null },
        ...(skillsLoaded && skillsCount > 0 ? [{
          label: showSkillSelector ? "hide selector" : "select skills",
          onClick: () => setShowSkillSelector(prev => !prev),
          disabled: wsRunning !== null,
        }] : []),
        { label: "open script", onClick: onOpenInstallScript, disabled: wsRunning !== null },
      ]}
      primaryAction={{
        label: "install",
        onClick: onInstall,
        disabled: !skillsCanInstall || wsRunning !== null,
      }}
    >
      {showSkillSelector && (
        <TargetSkillSelector
          skills={skills}
          selectedSkills={selectedSkills}
          skillSearch={skillSearch}
          onToggleSkill={onToggleSkill}
          onSelectAllSkills={onSelectAllSkills}
          onClearSelectionSkills={onClearSelectionSkills}
          onSetSkillSearch={onSetSkillSearch}
        />
      )}
    </HarnessActionCard>
  );
}
