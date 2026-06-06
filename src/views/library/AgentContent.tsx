import type { ActionResult } from "../../components/TerminalOutput";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import type { AgentMetadataResponse, AgentSourceContent } from "../../types";
import { SafeMarkdown } from "../../components/SafeMarkdown";

function skillRiskClass(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "ws-color-ok";
    case "medium": return "ws-color-warn";
    case "high": return "ws-color-fail";
    default: return "";
  }
}

interface AgentContentProps {
  agentSources: AgentMetadataResponse[];
  activeAgentContent: AgentSourceContent | null;
  onOpenAgent: (id: string) => void;
  agentDraft: string;
  agentDirty: boolean;
  agentSaving: boolean;
  agentSaveResult: ActionResult | null;
  agentMode: "preview" | "edit";
  onSetAgentMode: (mode: "preview" | "edit") => void;
  onChangeAgentDraft: (value: string) => void;
  onSaveAgent: () => void;
  onResetAgent: () => void;
}

export function AgentContent(props: AgentContentProps) {
  const {
    agentSources,
    activeAgentContent,
    onOpenAgent,
    agentDraft,
    agentDirty,
    agentSaving,
    agentSaveResult,
    agentMode,
    onSetAgentMode,
    onChangeAgentDraft,
    onSaveAgent,
    onResetAgent,
  } = props;

  if (!activeAgentContent) return null;

  const activeSrc = agentSources.find((s) => s.id === activeAgentContent.id);
  const meta = activeSrc?.metadata;

  return (
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">{activeAgentContent.title}</span>
          <span className="lib-editor-meta-path">{activeAgentContent.path}</span>
          {!activeAgentContent.exists && (
            <span className="lib-sidebar-item-tag lib-sidebar-item-tag-warn">not in workspace</span>
          )}
        </div>
        <div className="lib-editor-meta-right">
          {agentDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
          <button className="btn btn-sm" onClick={() => onOpenAgent(activeAgentContent.id)}>open</button>
        </div>
      </div>
      {meta && (
        <div className="configs-bundle-section" role="region" aria-label="Agent metadata">
          <span className="configs-bundle-header">metadata</span>
          {meta.role && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">role</span>
              <span className="configs-bundle-val">{meta.role}</span>
            </div>
          )}
          {meta.summary && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">summary</span>
              <span className="configs-bundle-val configs-bundle-val-sm">{meta.summary}</span>
            </div>
          )}
          {meta.risk && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">risk</span>
              <span className={`configs-bundle-val ${skillRiskClass(meta.risk)}`}>{meta.risk}</span>
            </div>
          )}
          {meta.targets.length > 0 && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">targets</span>
              <span className="configs-bundle-val">{meta.targets.join(", ")}</span>
            </div>
          )}
          {meta.default_skills.length > 0 && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">default skills</span>
              <span className="configs-bundle-val">{meta.default_skills.join(", ")}</span>
            </div>
          )}
          {!meta.safe_to_edit_runtime && (
            <div className="configs-bundle-item">
              <span className="configs-bundle-key">edit safety</span>
              <span className="configs-bundle-val ws-color-warn">runtime-sensitive — edit with care</span>
            </div>
          )}
          {meta.notes.length > 0 && (
            <div className="configs-bundle-section" role="region" aria-label="Agent notes">
              <span className="configs-bundle-header">notes</span>
              {meta.notes.map((note, i) => (
                <div key={i} className="configs-bundle-item">
                  <span className="configs-bundle-val configs-bundle-val-note">{note}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="editor-mode-tabs" role="tablist" aria-label="Agent view mode">
        <button className={`btn btn-sm ${agentMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetAgentMode("preview")} role="tab" aria-selected={agentMode === "preview"}>preview</button>
        <button className={`btn btn-sm ${agentMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetAgentMode("edit")} role="tab" aria-selected={agentMode === "edit"}>edit</button>
      </div>
      <div className="lib-editor-body">
        {agentMode === "preview" ? (
          <div className="lib-preview-body"><SafeMarkdown content={activeAgentContent.content} /></div>
        ) : (
          <textarea
            className="editor-textarea"
            value={agentDraft}
            onChange={(e) => onChangeAgentDraft(e.target.value)}
            spellCheck={false}
            aria-label="Edit agent source"
          />
        )}
      </div>
      {agentMode === "edit" && (
        <div className="editor-save-row">
          <button className="btn btn-primary btn-sm" onClick={onSaveAgent} disabled={agentSaving || !agentDirty}>
            {agentSaving ? "saving..." : "save"}
          </button>
          <button className="btn btn-sm" onClick={onResetAgent} disabled={agentSaving || !agentDirty}>reset</button>
          {agentSaveResult && (
            <span className={`editor-save-status ${agentSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
              {agentSaveResult.success
                ? redactTerminalOutput(agentSaveResult.stdout)
                : redactTerminalOutput(agentSaveResult.stderr) || "save failed"}
            </span>
          )}
          <span className="editor-save-note">workspace source</span>
        </div>
      )}
    </>
  );
}
