import type { AgentMetadataResponse, RoutingProfile, SkillSummary } from "../../types";
import { buildCompatibilityRows, hasCompatibilityData } from "./routingCompatibility";

interface RoutingCompatibilityOverviewProps {
  skills: SkillSummary[];
  agentSources: AgentMetadataResponse[];
  profiles: RoutingProfile[];
}

export function RoutingCompatibilityOverview({
  skills,
  agentSources,
  profiles,
}: RoutingCompatibilityOverviewProps) {
  const rows = buildCompatibilityRows(skills, agentSources, profiles);

  if (!hasCompatibilityData(rows)) return null;

  return (
    <div
      className="configs-bundle-section"
      role="region"
      aria-label="Resource compatibility overview"
    >
      <span className="configs-bundle-header">compatibility</span>
      <table className="routing-matrix" style={{ marginTop: 0 }}>
        <thead>
          <tr>
            <th>target</th>
            <th className="routing-matrix-cell-center">skills</th>
            <th className="routing-matrix-cell-center">agents</th>
            <th className="routing-matrix-cell-center">profiles</th>
            <th className="routing-matrix-cell-center">ready</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.tool}>
              <td>{row.tool}</td>
              <td className="routing-matrix-cell-center">{row.skillCount}</td>
              <td className="routing-matrix-cell-center">{row.agentCount}</td>
              <td className="routing-matrix-cell-center">{row.profileCount}</td>
              <td className="routing-matrix-cell-center">
                {row.profileCount > 0 ? (
                  row.readyProfileCount === row.profileCount ? (
                    <span className="ws-color-ok">{row.readyProfileCount}/{row.profileCount}</span>
                  ) : row.readyProfileCount === 0 ? (
                    <span className="ws-color-fail">{row.readyProfileCount}/{row.profileCount}</span>
                  ) : (
                    <span className="ws-color-warn">{row.readyProfileCount}/{row.profileCount}</span>
                  )
                ) : (
                  <span className="ws-detail-dim">&mdash;</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
