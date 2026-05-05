import { useState, useCallback } from "react";
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

  // Auto-select first profile if none selected
  if (!selectedId && profiles.length > 0) {
    setSelectedId(profiles[0].id);
  }

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
