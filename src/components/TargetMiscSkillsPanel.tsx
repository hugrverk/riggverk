import { useState } from "react";
import { SectionChip } from "../lib/runtimeUi";
import { TargetSkillSelector } from "./TargetSkillsPanel";
import type { SkillSummary } from "../types";

interface TargetMiscSkillsPanelProps {
  skills: SkillSummary[];
  skillsLoaded: boolean;
  selectedSkills: Set<string>;
  skillSearch: string;
  wsRunning: string | null;
  workspaceValid: boolean;
  onDryRunAuggie: () => void;
  onInstallAuggie: () => void;
  onDryRunClaude: () => void;
  onInstallClaude: () => void;
  onToggleSkill: (name: string) => void;
  onSelectAllSkills: () => void;
  onClearSelectionSkills: () => void;
  onSetSkillSearch: (value: string) => void;
  onOpenInstallScript: () => void;
}

export function TargetMiscSkillsPanel({
  skills,
  skillsLoaded,
  selectedSkills,
  skillSearch,
  wsRunning,
  workspaceValid,
  onDryRunAuggie,
  onInstallAuggie,
  onDryRunClaude,
  onInstallClaude,
  onToggleSkill,
  onSelectAllSkills,
  onClearSelectionSkills,
  onSetSkillSearch,
  onOpenInstallScript,
}: TargetMiscSkillsPanelProps) {
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
        : null;

  return (
    <div className="ws-section target-skills-compact" role="region" aria-label="Misc skills install">
      <div className="ws-section-header">
        <span className="ws-section-title">Skills</span>
        {skillsCount > 0 && (
          <SectionChip label={`${selectedSkillsCount}/${skillsCount}`} tone={selectionTone} />
        )}
      </div>

      <div className="target-skills-misc-rows">
        <div className="target-skills-misc-row">
          <SectionChip label="Auggie" tone="muted" />
          <div className="ws-section-actions target-skills-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!skillsCanInstall || wsRunning !== null}
              onClick={onDryRunAuggie}
            >
              dry run
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!skillsCanInstall || wsRunning !== null}
              onClick={onInstallAuggie}
            >
              install
            </button>
          </div>
        </div>
        <div className="target-skills-misc-row">
          <SectionChip label="Claude" tone="muted" />
          <div className="ws-section-actions target-skills-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!skillsCanInstall || wsRunning !== null}
              onClick={onDryRunClaude}
            >
              dry run
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!skillsCanInstall || wsRunning !== null}
              onClick={onInstallClaude}
            >
              install
            </button>
          </div>
        </div>
      </div>

      <div className="ws-section-actions target-skills-actions target-skills-misc-shared">
        {skillsLoaded && skillsCount > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowSkillSelector(prev => !prev)}
            aria-expanded={showSkillSelector}
          >
            {showSkillSelector ? "hide selector" : "select skills"}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onOpenInstallScript}>open script</button>
      </div>

      {selectionHint && (
        <p className="target-skills-hint">{selectionHint}</p>
      )}

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
    </div>
  );
}
