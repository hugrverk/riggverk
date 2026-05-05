import type { RoutingProfile } from "../../types";
import { riskClass, riskLabel, profileStatus } from "./routingHelpers";

interface RoutingMatrixProps {
  profiles: RoutingProfile[];
  selectedId: string | null;
  onSelectId: (id: string) => void;
}

export function RoutingMatrix({ profiles, selectedId, onSelectId }: RoutingMatrixProps) {
  return (
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
                  onClick={() => { onSelectId(p.id); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectId(p.id);
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
  );
}
