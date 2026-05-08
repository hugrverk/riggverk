import type { RoutingProfile } from "../../types";
import { riskClass, riskLabel, profileStatus } from "./routingHelpers";

interface RoutingMatrixProps {
  profiles: RoutingProfile[];
  selectedId: string | null;
  onSelectId: (id: string) => void;
}

export function RoutingMatrix({ profiles, selectedId, onSelectId }: RoutingMatrixProps) {
  return (
    <div className="routing-profile-list" role="list">
      {profiles.map((p) => {
        const status = profileStatus(p);
        const missingSkillCount = p.missing_skills.length;
        const totalSkills = p.skills.length;
        const agentLabel = p.agent_profile
          ? (p.missing_agent ? p.agent_profile + " \u2717" : p.agent_profile)
          : "\u2014";
        const isActive = selectedId === p.id;
        return (
          <button
            key={p.id}
            className={`routing-profile-block${isActive ? " routing-profile-block-active" : ""}`}
            role="listitem"
            onClick={() => { onSelectId(p.id); }}
            aria-current={isActive ? "true" : undefined}
            aria-label={`${p.title} — target ${p.target_tool}, model ${p.recommended_model}, risk ${riskLabel(p.risk)}, status ${status}${status === "warnings" ? `: ${missingSkillCount} skills missing` + (p.missing_agent ? ", agent missing" : "") : ""}`}
          >
            {/* Row 1: title + status */}
            <div className="routing-profile-row1">
              <span className="routing-profile-title">{p.title}</span>
              <span className={`routing-profile-status ${status === "ready" ? "ws-color-ok" : "ws-color-warn"}`}>
                {status === "ready" ? "ready" : "warnings"}
              </span>
            </div>

            {/* Row 2: id */}
            <div className="routing-profile-row2">
              <span className="routing-profile-id">{p.id}</span>
            </div>

            {/* Row 3: tool, model, risk, DB */}
            <div className="routing-profile-row3">
              <span className="routing-profile-field">
                tool <span className="routing-profile-val">{p.target_tool}</span>
              </span>
              <span className="routing-profile-sep">&middot;</span>
              <span className="routing-profile-field">
                model <span className="routing-profile-val">{p.recommended_model}</span>
              </span>
              <span className="routing-profile-sep">&middot;</span>
              <span className="routing-profile-field">
                risk <span className={riskClass(p.risk)}>{riskLabel(p.risk)}</span>
              </span>
              <span className="routing-profile-sep">&middot;</span>
              <span className="routing-profile-field">
                DB <span className="routing-profile-val-dim">{p.db_migration}</span>
              </span>
            </div>

            {/* Row 4: skills + agent */}
            <div className="routing-profile-row4">
              <span className="routing-profile-field">
                skills <span>{totalSkills}</span>
                {missingSkillCount > 0 && (
                  <span className="routing-profile-missing"> -{missingSkillCount}</span>
                )}
              </span>
              <span className="routing-profile-sep">&middot;</span>
              <span className="routing-profile-field">
                agent{" "}
                <span
                  className={
                    !p.agent_profile
                      ? "routing-profile-val-dim"
                      : p.missing_agent
                        ? "routing-profile-missing"
                        : ""
                  }
                >
                  {agentLabel}
                </span>
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
