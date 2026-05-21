import { useState, useMemo } from "react";
import { SectionChip } from "../lib/runtimeUi";
import type { InstallAgent, SkillSummary } from "../types";

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
  installAgents,
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
  const skillsCanInstall = workspaceValid && selectedSkillsCount > 0 && installAgents.length > 0;

  const filteredSkills = useMemo(() => {
    if (!skillSearch.trim()) return skills;
    const q = skillSearch.toLowerCase().trim();
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  }, [skills, skillSearch]);

  if (!workspaceValid) return null;

  const installLabel = installAgents.length === 1
    ? installAgents[0]
    : installAgents.join(" + ");

  return (
    <div className="ws-section" role="region" aria-label={`${targetName} skills install`}>
      <div className="ws-section-header">
        <span className="ws-section-title">SKILLS</span>
        {skillsCount > 0 && (() => {
          const tone: "ok" | "warn" | "fail" | "muted" = selectedSkillsCount === skillsCount
            ? "ok"
            : selectedSkillsCount > 0
              ? "warn"
              : "muted";
          return <SectionChip label={`${selectedSkillsCount}/${skillsCount} selected`} tone={tone} />;
        })()}
      </div>
      <div className="ws-section-context">
        Installs to {installLabel}
      </div>
      <div className="ws-section-actions">
        <button
          className="btn btn-sm"
          disabled={!skillsCanInstall || wsRunning !== null}
          onClick={onDryRun}
        >
          dry run
        </button>
        <button
          className="btn btn-sm btn-primary"
          disabled={!skillsCanInstall || wsRunning !== null}
          onClick={onInstall}
        >
          install
        </button>
        {skillsLoaded && skillsCount > 0 && (
          <button
            className="btn btn-sm"
            onClick={() => setShowSkillSelector(prev => !prev)}
            aria-expanded={showSkillSelector}
          >
            {showSkillSelector ? "hide selector" : "select skills"}
          </button>
        )}
        <button className="btn btn-sm" onClick={onOpenInstallScript}>open script</button>
      </div>
      {!skillsLoaded && !wsRunning && (
        <div className="ws-card-warn">Loading skills...</div>
      )}
      {skillsLoaded && !skillsCanInstall && !wsRunning && (
        <div className="ws-card-warn">
          {skills.length === 0
            ? "No skills found in workspace."
            : selectedSkillsCount === 0
              ? "No skills selected."
              : null}
        </div>
      )}
      {showSkillSelector && (
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
                className="btn btn-sm btn-clear-search"
                onClick={() => onSetSkillSearch("")}
                aria-label="Clear workspace skills search"
              >
                clear
              </button>
            )}
            <button className="btn btn-sm" onClick={onSelectAllSkills}>all</button>
            <button className="btn btn-sm" onClick={onClearSelectionSkills}>clear</button>
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
      )}
    </div>
  );
}
