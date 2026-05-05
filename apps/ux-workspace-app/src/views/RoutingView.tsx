import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActionResult, RoutingProfilesResponse } from "../types";
import { ProfileTemplate, PROFILE_TEMPLATES } from "./routing/routingTemplates";
import { riskClass, riskLabel, copyMetadataBlock } from "./routing/routingHelpers";
import { RoutingMatrix } from "./routing/RoutingMatrix";

interface RoutingViewProps {
  routingData: RoutingProfilesResponse | null;
  routingError: string | null;
  workspaceValid: boolean;
  onProfilesChanged: () => void;
  onRoutingDirtyChange?: (dirty: boolean) => void;
}

type RoutingMode = "preview" | "edit";

export function RoutingView({ routingData, routingError, workspaceValid, onProfilesChanged, onRoutingDirtyChange }: RoutingViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Edit mode state
  const [mode, setMode] = useState<RoutingMode>("preview");
  const [rawJSON, setRawJSON] = useState("");
  const [draftJSON, setDraftJSON] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<ActionResult | null>(null);

  const profiles = routingData?.profiles ?? [];
  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  const onCopy = useCallback(async () => {
    if (!selected) return;
    const block = copyMetadataBlock(selected);
    try {
      await navigator.clipboard.writeText(block);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const el = document.getElementById("routing-metadata-block");
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }, [selected]);

  // Auto-select first profile when data loads, and clear stale selections
  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !profiles.some((p) => p.id === selectedId)) {
      setSelectedId(profiles[0].id);
    }
  }, [profiles, selectedId]);

  // Propagate dirty state to parent for navigation guards
  useEffect(() => {
    onRoutingDirtyChange?.(dirty);
  }, [dirty, onRoutingDirtyChange]);

  // Load raw JSON when entering edit mode; initialize empty draft for missing file
  useEffect(() => {
    if (mode === "edit" && workspaceValid) {
      invoke<string>("read_routing_profiles_file")
        .then((raw) => {
          const content = raw || "{\n  \"profiles\": []\n}";
          setRawJSON(raw);
          setDraftJSON(content);
          setDirty(raw !== content);
          setSaveResult(null);
        })
        .catch(() => {
          setRawJSON("");
          setDraftJSON("{\n  \"profiles\": []\n}");
          setDirty(true);
        });
    }
  }, [mode, workspaceValid]);

  const onDraftChange = useCallback((value: string) => {
    setDraftJSON(value);
    setDirty(value !== rawJSON);
    setSaveResult(null);
  }, [rawJSON]);

  const onSwitchToEdit = useCallback(() => setMode("edit"), []);
  const onSwitchToPreview = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved routing changes?")) return;
    setMode("preview");
    setDirty(false);
    setSaveResult(null);
  }, [dirty]);

  const onReset = useCallback(() => {
    setDraftJSON(rawJSON);
    setDirty(false);
    setSaveResult(null);
  }, [rawJSON]);

  const onSave = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const result = await invoke<ActionResult>("save_routing_profiles", { content: draftJSON });
      setSaveResult(result);
      setRawJSON(draftJSON);
      setDirty(false);
      onProfilesChanged();
    } catch (e) {
      setSaveResult({
        success: false,
        action: "save_routing_profiles",
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setSaving(false);
    }
  }, [dirty, draftJSON, onProfilesChanged]);

  const onInsertTemplate = useCallback((template: ProfileTemplate) => {
    try {
      const current = JSON.parse(draftJSON);
      if (!current || !Array.isArray(current.profiles)) {
        setSaveResult({
          success: false,
          action: "insert_template",
          stdout: "",
          stderr: "Invalid JSON structure: missing 'profiles' array.",
          exit_code: null,
        });
        return;
      }
      const existingIds = new Set(current.profiles.map((p: { id: string }) => p.id));
      if (existingIds.has(template.id)) {
        setSaveResult({
          success: false,
          action: "insert_template",
          stdout: "",
          stderr: `Profile id "${template.id}" already exists. Remove the duplicate before inserting.`,
          exit_code: null,
        });
        return;
      }
      const newProfiles = [...current.profiles, template];
      const updated = { ...current, profiles: newProfiles };
      const json = JSON.stringify(updated, null, 2);
      setDraftJSON(json);
      setDirty(json !== rawJSON);
      setSaveResult(null);
    } catch {
      setSaveResult({
        success: false,
        action: "insert_template",
        stdout: "",
        stderr: "Fix JSON before inserting a template.",
        exit_code: null,
      });
    }
  }, [draftJSON, rawJSON]);

  const onFormatJSON = useCallback(() => {
    try {
      const parsed = JSON.parse(draftJSON);
      const formatted = JSON.stringify(parsed, null, 2);
      setDraftJSON(formatted);
      setDirty(formatted !== rawJSON);
      setSaveResult(null);
    } catch {
      setSaveResult({
        success: false,
        action: "format_json",
        stdout: "",
        stderr: "Cannot format: invalid JSON.",
        exit_code: null,
      });
    }
  }, [draftJSON, rawJSON]);

  const onValidateJSON = useCallback(() => {
    try {
      const parsed = JSON.parse(draftJSON);
      if (!parsed || !Array.isArray(parsed.profiles)) {
        setSaveResult({
          success: false,
          action: "validate_json",
          stdout: "",
          stderr: "Invalid structure: missing 'profiles' array.",
          exit_code: null,
        });
        return;
      }
      setSaveResult({
        success: true,
        action: "validate_json",
        stdout: `Valid JSON with ${parsed.profiles.length} profile(s).`,
        stderr: "",
        exit_code: null,
      });
    } catch (e) {
      setSaveResult({
        success: false,
        action: "validate_json",
        stdout: "",
        stderr: `Invalid JSON: ${String(e)}`,
        exit_code: null,
      });
    }
  }, [draftJSON]);

  const fileStatusText = !routingData
    ? "loading"
    : routingData.exists
      ? "found"
      : "not found";

  const fileStatusClass = !routingData
    ? "ws-status-dim"
    : routingData.exists
      ? "ws-status-valid"
      : "ws-status-invalid";

  const jsonValid = useCallback(() => {
    try {
      const parsed = JSON.parse(draftJSON);
      return parsed && Array.isArray(parsed.profiles);
    } catch {
      return false;
    }
  }, [draftJSON]);

  const templateButtonsDisabled = !jsonValid();

  const handleSelectId = useCallback((id: string) => {
    setSelectedId(id);
    setCopied(false);
  }, []);

  return (
    <section className="lib-frame">
      <div className="lib-topline">
        <span className="terminal-title">ROUTING</span>
        <span className="terminal-host">
          <span className={fileStatusClass}>routing/profiles.json: {fileStatusText}</span>
          {routingData?.exists && <span> &middot; {profiles.length} profile{profiles.length !== 1 ? "s" : ""}</span>}
          {routingError && <span className="ws-color-fail"> &middot; {routingError}</span>}
        </span>
      </div>

      <div className="lib-layout">
        {/* Profile list sidebar — only in preview mode */}
        {mode === "preview" && (
          <div className="lib-sidebar">
            <div className="lib-sidebar-body">
              {!workspaceValid ? (
                <div className="lib-sidebar-empty">No valid workspace</div>
              ) : routingError ? (
                <div className="lib-sidebar-empty ws-color-fail">{routingError}</div>
              ) : !routingData ? (
                <div className="lib-sidebar-empty">Loading...</div>
              ) : profiles.length === 0 ? (
                <div className="lib-sidebar-empty">
                  {routingData.exists ? "No profiles defined" : "File not found"}
                  <div className="ws-detail-dim" style={{ marginTop: 4, fontSize: 11 }}>
                    {routingData.path}
                  </div>
                </div>
              ) : (
                <div className="lib-sidebar-list">
                  {profiles.map((p) => (
                    <button
                      key={p.id}
                      className={`lib-sidebar-item ${selectedId === p.id ? "lib-sidebar-item-active" : ""}`}
                      onClick={() => handleSelectId(p.id)}
                      aria-current={selectedId === p.id ? "true" : undefined}
                    >
                      <span className="lib-sidebar-item-title">{p.title}</span>
                      <span className="lib-sidebar-item-desc">{p.target_tool} &middot; {riskLabel(p.risk)} risk</span>
                      {(p.missing_skills.length > 0 || p.missing_agent) && (
                        <span className="lib-sidebar-item-tag lib-sidebar-item-tag-warn">
                          validation
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Main content */}
        <div className="lib-main">
          {/* Mode toggle */}
          {workspaceValid && (
            <div className="editor-mode-tabs">
              <button
                className={`btn btn-sm ${mode === "preview" ? "btn-active" : ""}`}
                onClick={onSwitchToPreview}
                aria-pressed={mode === "preview"}
              >
                preview
              </button>
              <button
                className={`btn btn-sm ${mode === "edit" ? "btn-active" : ""}`}
                onClick={onSwitchToEdit}
                aria-pressed={mode === "edit"}
              >
                edit JSON
              </button>
              {dirty && <span className="editor-dirty">modified</span>}
            </div>
          )}

          {/* Edit mode */}
          {mode === "edit" && (
            <div className="routing-edit-layout">
              {/* Template insert row */}
              <div className="routing-template-row">
                <span className="routing-template-hint">insert profile template:</span>
                {PROFILE_TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    className="btn btn-sm"
                    onClick={() => onInsertTemplate(t.profile)}
                    disabled={templateButtonsDisabled}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* JSON editor */}
              <textarea
                className="editor-textarea"
                value={draftJSON}
                onChange={(e) => onDraftChange(e.target.value)}
                spellCheck={false}
                aria-label="Routing profiles JSON editor"
              />

              {/* Save row */}
              <div className="editor-save-row">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onSave}
                  disabled={!dirty || saving}
                >
                  {saving ? "saving..." : "save"}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={onReset}
                  disabled={!dirty}
                >
                  reset
                </button>
                <button
                  className="btn btn-sm"
                  onClick={onFormatJSON}
                >
                  format
                </button>
                <button
                  className="btn btn-sm"
                  onClick={onValidateJSON}
                >
                  validate
                </button>
                {saveResult && (
                  <span className={`editor-save-status ${saveResult.success ? "editor-save-ok" : "editor-save-fail"}`}>
                    {saveResult.success ? saveResult.stdout : saveResult.stderr}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Preview mode */}
          {mode === "preview" && !selected ? (
            <div className="lib-main-empty">
              <span className="log-prompt">$</span>{" "}
              {workspaceValid
                ? profiles.length === 0
                  ? "No routing profiles available. Add routing/profiles.json to your workspace."
                  : "Select a routing profile"
                : "No valid workspace selected"}
            </div>
          ) : mode === "preview" && selected ? (
            <>
              {/* Compatibility / status matrix */}
              {profiles.length > 0 && (
                <RoutingMatrix
                  profiles={profiles}
                  selectedId={selectedId}
                  onSelectId={handleSelectId}
                />
              )}

              {/* Meta strip */}
              <div className="lib-editor-meta-strip">
                <div className="lib-editor-meta-left">
                  <span className="lib-editor-meta-title">{selected.title}</span>
                  <span className="lib-editor-meta-path">{selected.id}</span>
                </div>
                <div className="lib-editor-meta-right">
                  <button className="btn btn-sm" onClick={onCopy}>
                    {copied ? "copied" : "copy metadata"}
                  </button>
                </div>
              </div>

              {/* Profile details */}
              <div className="configs-bundle-section" role="region" aria-label="Routing profile details">
                <div className="configs-bundle-item">
                  <span className="configs-bundle-key">target tool</span>
                  <span className="configs-bundle-val">{selected.target_tool}</span>
                </div>
                <div className="configs-bundle-item">
                  <span className="configs-bundle-key">recommended model</span>
                  <span className="configs-bundle-val">{selected.recommended_model}</span>
                </div>
                <div className="configs-bundle-item">
                  <span className="configs-bundle-key">DB/migration</span>
                  <span className="configs-bundle-val">{selected.db_migration}</span>
                </div>
                <div className="configs-bundle-item">
                  <span className="configs-bundle-key">risk</span>
                  <span className={`configs-bundle-val ${riskClass(selected.risk)}`}>
                    {riskLabel(selected.risk)}
                  </span>
                </div>
              </div>

              {/* Description */}
              {selected.description && (
                <div className="lib-editor-body">
                  <div className="lib-preview-body">
                    <p style={{ margin: 0, opacity: 0.85 }}>{selected.description}</p>
                  </div>
                </div>
              )}

              {/* Skills section */}
              <div className="configs-bundle-section" role="region" aria-label="Skills">
                <span className="configs-bundle-header">
                  skills
                  {selected.missing_skills.length > 0 && (
                    <span className="lib-sidebar-item-tag lib-sidebar-item-tag-warn" style={{ marginLeft: 8 }}>
                      {selected.missing_skills.length} missing
                    </span>
                  )}
                </span>
                {selected.skills.length === 0 ? (
                  <span className="configs-bundle-item">
                    <span className="configs-bundle-val ws-detail-dim">none specified</span>
                  </span>
                ) : (
                  selected.skills.map((skill, i) => {
                    const isMissing = selected.missing_skills.includes(skill);
                    return (
                      <span key={i} className="configs-bundle-item">
                        <span className={`configs-bundle-val ${isMissing ? "ws-color-fail" : ""}`}>
                          {skill}
                          {isMissing && " (not in workspace)"}
                        </span>
                      </span>
                    );
                  })
                )}
              </div>

              {/* Agent profile section */}
              <div className="configs-bundle-section" role="region" aria-label="Agent profile">
                <span className="configs-bundle-header">
                  agent profile
                  {selected.missing_agent && (
                    <span className="lib-sidebar-item-tag lib-sidebar-item-tag-warn" style={{ marginLeft: 8 }}>
                      missing in ws
                    </span>
                  )}
                </span>
                {selected.agent_profile ? (
                  <span className="configs-bundle-item">
                    <span className={`configs-bundle-val ${selected.missing_agent ? "ws-color-fail" : ""}`}>
                      {selected.agent_profile}
                      {selected.missing_agent && " (not in workspace)"}
                    </span>
                  </span>
                ) : (
                  <span className="configs-bundle-item">
                    <span className="configs-bundle-val ws-detail-dim">none specified</span>
                  </span>
                )}
              </div>

              {/* Notes section */}
              {selected.notes.length > 0 && (
                <div className="configs-bundle-section" role="region" aria-label="Notes">
                  <span className="configs-bundle-header">notes</span>
                  {selected.notes.map((note, i) => (
                    <div key={i} className="configs-bundle-item">
                      <span className="configs-bundle-val">{note}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Warnings section */}
              {routingData && routingData.warnings.length > 0 && (
                <div className="configs-bundle-section" role="region" aria-label="Validation warnings">
                  <span className="configs-bundle-header ws-color-warn">
                    warnings ({routingData.warnings.length})
                  </span>
                  {routingData.warnings.map((w, i) => (
                    <div key={i} className="configs-bundle-item">
                      <span className="configs-bundle-val ws-color-fail">{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Metadata block (selectable textarea fallback) */}
              <div className="configs-bundle-section" role="region" aria-label="Metadata block">
                <span className="configs-bundle-header">metadata block</span>
                <pre
                  id="routing-metadata-block"
                  className="configs-code"
                  style={{ userSelect: "all", cursor: "text", margin: 0, fontSize: 11 }}
                >
                  {copyMetadataBlock(selected)}
                </pre>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
