import { useMemo } from "react";
import type { ActionResult } from "../../components/TerminalOutput";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import type { AgentMetadataResponse, AgentTargetMeta, DocumentContent } from "../../types";

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

interface ConfigContentProps {
  configTemplateContent: DocumentContent | null;
  activeConfigTargetId: string;
  configTargets: AgentTargetMeta[];
  onOpenConfig: () => void;
  configDraft: string;
  configDirty: boolean;
  configSaving: boolean;
  configSaveResult: ActionResult | null;
  configMode: "preview" | "edit";
  onSetConfigMode: (mode: "preview" | "edit") => void;
  onChangeConfigDraft: (value: string) => void;
  onSaveConfig: () => void;
  onResetConfig: () => void;
  agentSources: AgentMetadataResponse[];
}

export function ConfigContent(props: ConfigContentProps) {
  const {
    configTemplateContent,
    activeConfigTargetId,
    configTargets,
    onOpenConfig,
    configDraft,
    configDirty,
    configSaving,
    configSaveResult,
    configMode,
    onSetConfigMode,
    onChangeConfigDraft,
    onSaveConfig,
    onResetConfig,
    agentSources,
  } = props;

  if (!configTemplateContent) return null;

  const selectedConfigTarget = configTargets.find((t) => t.id === activeConfigTargetId);
  const sourcePath = selectedConfigTarget?.source_rel ?? "";
  const targetPath = selectedConfigTarget?.target_rel ?? "";
  const formattedJson = useMemo(() => formatJson(configTemplateContent.content), [configTemplateContent.content]);

  return (
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">{selectedConfigTarget?.label ?? "Config"}</span>
          <span className="lib-editor-meta-path">
            {sourcePath && <span>template: {sourcePath}</span>}
            {sourcePath && targetPath && <span> &middot; </span>}
            {targetPath && <span>target: {targetPath}</span>}
          </span>
        </div>
        <div className="lib-editor-meta-right">
          {configDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
          <button className="btn btn-sm" onClick={onOpenConfig}>open</button>
        </div>
      </div>
      {activeConfigTargetId === "opencode_config" && (
        <div className="configs-bundle-section" role="region" aria-label="OpenCode config + agents bundle">
          <span className="configs-bundle-header">bundle contents</span>
          <span className="configs-bundle-item">
            <span className="configs-bundle-key">config</span>
            <span className="configs-bundle-val">templates/opencode.json &rarr; ~/.config/opencode/opencode.json</span>
          </span>
          <span className="configs-bundle-item">
            <span className="configs-bundle-key">agents</span>
            <span className="configs-bundle-val">agents/*.md &rarr; ~/.config/opencode/agents/*.md</span>
          </span>
          <span className="configs-bundle-item">
            <span className="configs-bundle-key">bundled</span>
            <span className="configs-bundle-val">
              {agentSources.length > 0 ? `${agentSources.length} agents` : "agents bundled"}
            </span>
          </span>
          <span className="configs-bundle-note">sync writes both config + agent files</span>
        </div>
      )}
      <div className="editor-mode-tabs" role="tablist" aria-label="Config view mode">
        <button className={`btn btn-sm ${configMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetConfigMode("preview")} role="tab" aria-selected={configMode === "preview"}>preview</button>
        <button className={`btn btn-sm ${configMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetConfigMode("edit")} role="tab" aria-selected={configMode === "edit"}>edit</button>
      </div>
      <div className="lib-editor-body">
        {configMode === "preview" ? (
          <pre className="configs-code">{formattedJson}</pre>
        ) : (
          <textarea
            className="editor-textarea"
            value={configDraft}
            onChange={(e) => onChangeConfigDraft(e.target.value)}
            spellCheck={false}
            aria-label="Edit config template"
          />
        )}
      </div>
      {configMode === "edit" && (
        <div className="editor-save-row">
          <button className="btn btn-primary btn-sm" onClick={onSaveConfig} disabled={configSaving || !configDirty}>
            {configSaving ? "saving..." : "save"}
          </button>
          <button className="btn btn-sm" onClick={onResetConfig} disabled={configSaving || !configDirty}>reset</button>
          {configSaveResult && (
            <span className={`editor-save-status ${configSaveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
              {configSaveResult.success
                ? redactTerminalOutput(configSaveResult.stdout)
                : redactTerminalOutput(configSaveResult.stderr) || "save failed"}
            </span>
          )}
          <span className="editor-save-note">template only</span>
        </div>
      )}
    </>
  );
}
