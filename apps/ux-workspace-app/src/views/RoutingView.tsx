import { useState, useCallback, useEffect } from "react";
import type { RoutingProfile, RoutingProfilesResponse } from "../types";

interface RoutingViewProps {
  routingData: RoutingProfilesResponse | null;
  routingError: string | null;
  workspaceValid: boolean;
}

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

export function RoutingView({ routingData, routingError, workspaceValid }: RoutingViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
      // Clipboard API unavailable — fall back to text selection
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
        {/* Profile list sidebar */}
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

        {/* Main content */}
        <div className="lib-main">
          {!selected ? (
            <div className="lib-main-empty">
              <span className="log-prompt">$</span>{" "}
              {workspaceValid
                ? profiles.length === 0
                  ? "No routing profiles available. Add routing/profiles.json to your workspace."
                  : "Select a routing profile"
                : "No valid workspace selected"}
            </div>
          ) : (
            <>
              {/* Compatibility / status matrix */}
              {profiles.length > 0 && (
                <div className="configs-bundle-section" role="region" aria-label="Profile compatibility matrix">
                  <span className="configs-bundle-header">
                    profiles ({profiles.length})
                  </span>
                  <div style={{ overflowX: "auto" }}>
                    <table className="routing-matrix" style={{
                      width: "100%", borderCollapse: "collapse", fontSize: 11,
                      border: "1px solid var(--ws-border, #2d2d2d)",
                    }}>
                      <thead>
                        <tr>
                          <th style={{ padding: "4px 8px", textAlign: "left", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>profile</th>
                          <th style={{ padding: "4px 8px", textAlign: "left", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>tool</th>
                          <th style={{ padding: "4px 8px", textAlign: "left", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>model</th>
                          <th style={{ padding: "4px 8px", textAlign: "center", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>risk</th>
                          <th style={{ padding: "4px 8px", textAlign: "center", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>DB</th>
                          <th style={{ padding: "4px 8px", textAlign: "center", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>skills</th>
                          <th style={{ padding: "4px 8px", textAlign: "left", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>agent</th>
                          <th style={{ padding: "4px 8px", textAlign: "center", borderBottom: "1px solid var(--ws-border, #2d2d2d)", fontWeight: 600, opacity: 0.7 }}>status</th>
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
                          return (
                            <tr
                              key={p.id}
                              onClick={() => { setSelectedId(p.id); setCopied(false); }}
                              style={{
                                cursor: "pointer",
                                backgroundColor: selectedId === p.id ? "var(--ws-row-active, rgba(255,255,255,0.06))" : "transparent",
                                borderBottom: "1px solid var(--ws-hairline, rgba(255,255,255,0.06))",
                              }}
                              aria-current={selectedId === p.id ? "true" : undefined}
                            >
                              <td style={{ padding: "3px 8px", whiteSpace: "nowrap" }}>
                                <span style={{ fontWeight: 500 }}>{p.title}</span>
                                <span style={{ opacity: 0.5, marginLeft: 6 }}>{p.id}</span>
                              </td>
                              <td style={{ padding: "3px 8px", whiteSpace: "nowrap" }}>{p.target_tool}</td>
                              <td style={{ padding: "3px 8px", whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", opacity: 0.8 }}>{p.recommended_model}</td>
                              <td style={{ padding: "3px 8px", textAlign: "center" }}>
                                <span className={riskClass(p.risk)} style={{ fontWeight: 600 }}>{riskLabel(p.risk)}</span>
                              </td>
                              <td style={{ padding: "3px 8px", textAlign: "center", opacity: 0.7 }}>{p.db_migration}</td>
                              <td style={{ padding: "3px 8px", textAlign: "center" }}>
                                <span>{totalSkills}</span>
                                {missingSkillCount > 0 && (
                                  <span className="ws-color-fail" style={{ marginLeft: 3 }}>-{missingSkillCount}</span>
                                )}
                              </td>
                              <td style={{ padding: "3px 8px", whiteSpace: "nowrap", opacity: p.agent_profile ? 0.85 : 0.4, fontSize: 10 }}>
                                {agentLabel}
                              </td>
                              <td style={{ padding: "3px 8px", textAlign: "center" }}>
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
          )}
        </div>
      </div>
    </section>
  );
}
