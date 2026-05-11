import { useMemo } from "react";
import type { ActionResult } from "../../components/TerminalOutput";
import { redactTerminalOutput } from "../../lib/redactTerminalOutput";
import type { AgentMetadataResponse, AgentTargetMeta, ConfigEditorSourceMeta, DocumentContent } from "../../types";

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
  // Config editor source props (opencode_config only)
  configEditorSources: ConfigEditorSourceMeta[];
  activeConfigSourceType: string;
  onSelectConfigSource: (sourceType: string) => void;
  configEditorSourceSaveMessage: string;
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
    configEditorSources,
    activeConfigSourceType,
    onSelectConfigSource,
    configEditorSourceSaveMessage,
  } = props;

  if (!configTemplateContent) return null;

  const selectedConfigTarget = configTargets.find((t) => t.id === activeConfigTargetId);
  const targetPath = selectedConfigTarget?.target_rel ?? "";

  const activeSource = configEditorSources.find((s) => s.id === activeConfigSourceType);
  const sourcePath = activeSource?.rel_path ?? selectedConfigTarget?.source_rel ?? "";

  const isOpenCodeConfig = activeConfigTargetId === "opencode_config";
  const isSnapshot = isOpenCodeConfig && activeConfigSourceType === "snapshot";
  const currentSourceIsEditable = activeSource ? activeSource.editable : true;

  const formattedJson = useMemo(() => formatJson(configTemplateContent.content), [configTemplateContent.content]);

  // Determine edit mode availability
  const canEdit = currentSourceIsEditable && configMode === "edit";

  return (
    <>
      <div className="lib-editor-meta-strip">
        <div className="lib-editor-meta-left">
          <span className="lib-editor-meta-title">{selectedConfigTarget?.label ?? "Config"}</span>
          <span className="lib-editor-meta-path">
            {sourcePath && <span>{sourcePath}</span>}
            {sourcePath && targetPath && <span> &middot; </span>}
            {targetPath && <span>target: {targetPath}</span>}
          </span>
        </div>
        <div className="lib-editor-meta-right">
          {configDirty && <span className="editor-dirty" aria-label="Unsaved changes">modified</span>}
          <button className="btn btn-sm" onClick={onOpenConfig}>open</button>
        </div>
      </div>

      {/* Source selector for opencode_config */}
      {isOpenCodeConfig && configEditorSources.length > 0 && (
        <div className="config-source-selector" role="tablist" aria-label="Config source selector">
          {configEditorSources.map((src) => {
            const selected = src.id === activeConfigSourceType;
            return (
              <button
                key={src.id}
                className={`config-source-tab ${selected ? "config-source-tab-active" : ""} ${!src.editable ? "config-source-tab-readonly" : ""}`}
                onClick={() => onSelectConfigSource(src.id)}
                role="tab"
                aria-selected={selected}
                title={src.helper}
              >
                <span className="config-source-tab-label">{src.label}</span>
                <span className="config-source-tab-helper">{src.helper}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Bundle summary for opencode_config */}
      {isOpenCodeConfig && (
        <div className="configs-bundle-section" role="region" aria-label="OpenCode config + agents bundle">
          <span className="configs-bundle-header">bundle contents</span>
          <span className="configs-bundle-item">
            <span className="configs-bundle-key">source</span>
            <span className="configs-bundle-val">templates/opencode.base.json + templates/opencode.policy.json</span>
          </span>
          <span className="configs-bundle-item">
            <span className="configs-bundle-key">snapshot</span>
            <span className="configs-bundle-val">templates/opencode.json &rarr; ~/.config/opencode/opencode.json</span>
          </span>
          <span className="configs-bundle-item">
            <span className="configs-bundle-key">tui</span>
            <span className="configs-bundle-val">templates/tui.json &rarr; ~/.config/opencode/tui.json</span>
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
        </div>
      )}

      {/* Snapshot helper text */}
      {isSnapshot && (
        <div className="config-snapshot-notice">
          Generated snapshot. Edit Base or Policy instead.
        </div>
      )}

      {/* Mode tabs - hide edit for snapshot */}
      <div className="editor-mode-tabs" role="tablist" aria-label="Config view mode">
        <button className={`btn btn-sm ${configMode === "preview" ? "btn-active" : ""}`} onClick={() => onSetConfigMode("preview")} role="tab" aria-selected={configMode === "preview"}>preview</button>
        {currentSourceIsEditable && (
          <button className={`btn btn-sm ${configMode === "edit" ? "btn-active" : ""}`} onClick={() => onSetConfigMode("edit")} role="tab" aria-selected={configMode === "edit"}>edit</button>
        )}
      </div>

      <div className="lib-editor-body">
        {configMode === "preview" ? (
          <pre className="configs-code">{formattedJson}</pre>
        ) : (
          canEdit && (
            <textarea
              className="editor-textarea"
              value={configDraft}
              onChange={(e) => onChangeConfigDraft(e.target.value)}
              spellCheck={false}
              aria-label="Edit config source"
            />
          )
        )}
      </div>

      {/* Save bar - only show for editable sources */}
      {currentSourceIsEditable && configMode === "edit" && (
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
          {configEditorSourceSaveMessage && (
            <span className="editor-save-status editor-save-ok">{configEditorSourceSaveMessage}</span>
          )}
        </div>
      )}
    </>
  );
}
