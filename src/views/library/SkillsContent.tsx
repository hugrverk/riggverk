import type { DocumentContent, SkillSummary } from "../../types";
import { SafeMarkdown } from "../../components/SafeMarkdown";

function skillRiskClass(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "ws-color-ok";
    case "medium": return "ws-color-warn";
    case "high": return "ws-color-fail";
    default: return "";
  }
}

interface SkillsContentProps {
  skills: SkillSummary[];
  activeSkillContent: DocumentContent | null;
  onOpenSkill: (id: string) => void;
}

export function SkillsContent(props: SkillsContentProps) {
  const { skills, activeSkillContent, onOpenSkill } = props;

  if (!activeSkillContent) return null;

  const activeSkill = skills.find((s) => s.id === activeSkillContent.id);

  return (
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">{activeSkillContent.title}</span>
          <span className="lib-editor-meta-path">{activeSkillContent.section} &middot; {activeSkillContent.path}</span>
        </div>
        <div className="lib-editor-meta-right">
          <button className="btn btn-sm" onClick={() => onOpenSkill(activeSkillContent.id)}>open</button>
        </div>
      </div>
      {activeSkill && (activeSkill.category || activeSkill.risk || activeSkill.targets.length > 0 || activeSkill.related.length > 0) && (
        <div className="configs-bundle-section" role="region" aria-label="Skill metadata">
          <span className="configs-bundle-header">metadata</span>
          {activeSkill.category && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">category</span>
              <span className="configs-bundle-val">{activeSkill.category}</span>
            </div>
          )}
          {activeSkill.risk && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">risk</span>
              <span className={`configs-bundle-val ${skillRiskClass(activeSkill.risk)}`}>{activeSkill.risk}</span>
            </div>
          )}
          {activeSkill.targets.length > 0 && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">targets</span>
              <span className="configs-bundle-val">{activeSkill.targets.join(", ")}</span>
            </div>
          )}
          {activeSkill.related.length > 0 && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">related</span>
              <span className="configs-bundle-val">{activeSkill.related.join(", ")}</span>
            </div>
          )}
        </div>
      )}
      <div className="lib-editor-body">
        <div className="lib-preview-body"><SafeMarkdown content={activeSkillContent.content} /></div>
      </div>
    </>
  );
}
