import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActionResult, RoutingProfile, RoutingProfilesResponse } from "../types";

interface RoutingViewProps {
  routingData: RoutingProfilesResponse | null;
  routingError: string | null;
  workspaceValid: boolean;
  onProfilesChanged: () => void;
}

type RoutingMode = "preview" | "edit";

interface ProfileTemplate {
  id: string;
  title: string;
  description: string;
  target_tool: string;
  recommended_model: string;
  db_migration: string;
  risk: string;
  skills: string[];
  agent_profile: string | null;
  notes: string[];
}

const PROFILE_TEMPLATES: { label: string; profile: ProfileTemplate }[] = [
  {
    label: "generic-codex-review",
    profile: {
      id: "generic-codex-review",
      title: "Generic Codex Review",
      description: "Code review with Codex for general-purpose tasks.",
      target_tool: "codex",
      recommended_model: "GPT-5.5 Medium",
      db_migration: "NO",
      risk: "low",
      skills: ["code-reviewer"],
      agent_profile: "code-reviewer.md",
      notes: [],
    },
  },
  {
    label: "generic-opencode-implementation",
    profile: {
      id: "generic-opencode-implementation",
      title: "Generic OpenCode Implementation",
      description: "Implementation work using OpenCode with diagnostics support.",
      target_tool: "opencode",
      recommended_model: "opencode-go/deepseek-v4-pro",
      db_migration: "NO",
      risk: "medium",
      skills: ["diagnose", "implementation-plan"],
      agent_profile: null,
      notes: [],
    },
  },
  {
    label: "frontend-ui",
    profile: {
      id: "frontend-ui",
      title: "Frontend UI",
      description: "Frontend design and implementation with accessibility review.",
      target_tool: "opencode",
      recommended_model: "opencode-go/deepseek-v4-pro",
      db_migration: "NO",
      risk: "medium",
      skills: ["frontend-design", "accessibility-review", "browser-qa"],
      agent_profile: null,
      notes: [],
    },
  },
  {
    label: "security-review",
    profile: {
      id: "security-review",
      title: "Security Review",
      description: "Security audit with backend code analysis.",
      target_tool: "opencode",
      recommended_model: "opencode-go/deepseek-v4-pro",
      db_migration: "NO",
      risk: "high",
      skills: ["security-review", "diagnose"],
      agent_profile: "security-auditor.md",
      notes: ["Run security-review before any deployment affecting auth, uploads, or payments."],
    },
  },
];

function riskClass(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "ws-color-ok";
    case "medium": return "ws-color-warn";
    case "high": return "ws-color-fail";
    default: return "";
  }
}

function riskLabel(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    default: return risk;
  }
}

function copyMetadataBlock(profile: RoutingProfile): string {
  const riskText = riskLabel(profile.risk);
  const skills = profile.skills.join(", ") || "none";
  const agent = profile.agent_profile ?? "none";
  const block = [
    `Recommended target: ${profile.target_tool} / ${profile.recommended_model}`,
    `DB/migration: ${profile.db_migration}`,
    `Token/audit warning: ${riskText}`,
    `Skills: ${skills}`,
    `Agent profile: ${agent}`,
    `Routing profile: ${profile.id}`,
  ].join("\n");
  return block;
}

function profileStatus(profile: RoutingProfile): "ready" | "warnings" {
  if (profile.missing_skills.length > 0 || profile.missing_agent) return "warnings";
  return "ready";
}

export function RoutingView({ routingData, routingError, workspaceValid, onProfilesChanged }: RoutingViewProps) {
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

  // Load raw JSON when entering edit mode
  useEffect(() => {
    if (mode === "edit" && workspaceValid) {
      invoke<string>("read_routing_profiles_file")
        .then((raw) => {
          setRawJSON(raw);
          setDraftJSON(raw);
          setDirty(false);
          setSaveResult(null);
        })
        .catch(() => {
          setRawJSON("");
          setDraftJSON("");
          setDirty(false);
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
                      onClick={() => { setSelectedId(p.id); setCopied(false); }}
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
                <div className="configs-bundle-section" role="region" aria-label="Profile compatibility matrix">
                  <span className="configs-bundle-header">
                    profiles ({profiles.length})
                  </span>
                  <div style={{ overflowX: "auto" }}>
                    <table className="routing-matrix">
                      <thead>
                        <tr>
                          <th>profile</th>
                          <th>tool</th>
                          <th>model</th>
                          <th className="routing-matrix-cell-center">risk</th>
                          <th className="routing-matrix-cell-center">DB</th>
                          <th className="routing-matrix-cell-center">skills</th>
                          <th>agent</th>
                          <th className="routing-matrix-cell-center">status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profiles.map((p) => {
                          const status = profileStatus(p);
                          const missingSkillCount = p.missing_skills.length;
                          const totalSkills = p.skills.length;
                          const agentLabel = p.agent_profile
                            ? (p.missing_agent ? p.agent_profile + " \u2717" : p.agent_profile)
                            : "\u2014";
                          const isActive = selectedId === p.id;
                          return (
                            <tr
                              key={p.id}
                              tabIndex={0}
                              role="row"
                              className={isActive ? "routing-matrix-row-active" : ""}
                              onClick={() => { setSelectedId(p.id); setCopied(false); }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setSelectedId(p.id);
                                  setCopied(false);
                                }
                              }}
                              aria-current={isActive ? "true" : undefined}
                              aria-label={`${p.title} — ${riskLabel(p.risk)} risk${status === "warnings" ? ", warnings" : ""}`}
                            >
                              <td>
                                <span className="routing-matrix-title">{p.title}</span>
                                <span className="routing-matrix-id">{p.id}</span>
                              </td>
                              <td>{p.target_tool}</td>
                              <td className="routing-matrix-model">{p.recommended_model}</td>
                              <td className="routing-matrix-cell-center">
                                <span className={riskClass(p.risk)} style={{ fontWeight: 600 }}>{riskLabel(p.risk)}</span>
                              </td>
                              <td className="routing-matrix-cell-center" style={{ opacity: 0.7 }}>{p.db_migration}</td>
                              <td className="routing-matrix-cell-center">
                                <span>{totalSkills}</span>
                                {missingSkillCount > 0 && (
                                  <span className="ws-color-fail" style={{ marginLeft: 3 }}>-{missingSkillCount}</span>
                                )}
                              </td>
                              <td style={{ opacity: p.agent_profile ? 0.85 : 0.4, fontSize: 10 }}>
                                {agentLabel}
                              </td>
                              <td className="routing-matrix-cell-center">
                                {status === "ready" ? (
                                  <span className="ws-color-ok">ready</span>
                                ) : (
                                  <span className="ws-color-warn">warnings</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
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
