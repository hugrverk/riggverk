import type { ActionResult } from "../../components/TerminalOutput";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import type { DocumentContent } from "../../types";
import { Markdown } from "../../components/Markdown";

interface RulesContentProps {
  agentTemplate: DocumentContent | null;
  onOpenTemplate: () => void;
  agentTemplateDraft: string;
  agentTemplateDirty: boolean;
  agentTemplateSaving: boolean;
  agentTemplateSaveResult: ActionResult | null;
  agentTemplateMode: "preview" | "edit";
  onSetAgentTemplateMode: (mode: "preview" | "edit") => void;
  onChangeAgentTemplateDraft: (value: string) => void;
  onSaveAgentTemplate: () => void;
  onResetAgentTemplate: () => void;
}

export function RulesContent(props: RulesContentProps) {
  const {
    agentTemplate,
    onOpenTemplate,
    agentTemplateDraft,
    agentTemplateDirty,
    agentTemplateSaving,
    agentTemplateSaveResult,
    agentTemplateMode,
    onSetAgentTemplateMode,
    onChangeAgentTemplateDraft,
    onSaveAgentTemplate,
    onResetAgentTemplate,
  } = props;

  if (!agentTemplate) return null;

  return (
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">Global Rules</span>
          <span className="lib-editor-meta-path">{agentTemplate.path}</span>
        </div>
        <div className="lib-editor-meta-right">
          {agentTemplateDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
          <button className="btn btn-sm" onClick={onOpenTemplate}>open</button>
        </div>
      </div>
      <div className="editor-mode-tabs" role="tablist" aria-label="Rules view mode">
        <button className={`btn btn-sm ${agentTemplateMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetAgentTemplateMode("preview")} role="tab" aria-selected={agentTemplateMode === "preview"}>preview</button>
        <button className={`btn btn-sm ${agentTemplateMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetAgentTemplateMode("edit")} role="tab" aria-selected={agentTemplateMode === "edit"}>edit</button>
      </div>
      <div className="lib-editor-body">
        {agentTemplateMode === "preview" ? (
          <div className="lib-preview-body"><Markdown content={agentTemplate.content} /></div>
        ) : (
          <textarea
            className="editor-textarea"
            value={agentTemplateDraft}
            onChange={(e) => onChangeAgentTemplateDraft(e.target.value)}
            spellCheck={false}
            aria-label="Edit agent rules template"
          />
        )}
      </div>
      {agentTemplateMode === "edit" && (
        <div className="editor-save-row">
          <button className="btn btn-primary btn-sm" onClick={onSaveAgentTemplate} disabled={agentTemplateSaving || !agentTemplateDirty}>
            {agentTemplateSaving ? "saving..." : "save"}
          </button>
          <button className="btn btn-sm" onClick={onResetAgentTemplate} disabled={agentTemplateSaving || !agentTemplateDirty}>reset</button>
          {agentTemplateSaveResult && (
            <span className={`editor-save-status ${agentTemplateSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
              {agentTemplateSaveResult.success
                ? redactTerminalOutput(agentTemplateSaveResult.stdout)
                : redactTerminalOutput(agentTemplateSaveResult.stderr) || "save failed"}
            </span>
          )}
          <span className="editor-save-note">template only</span>
        </div>
      )}
    </>
  );
}
