import type { RoutingProfile } from "../../types";

export function riskClass(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "ws-color-ok";
    case "medium": return "ws-color-warn";
    case "high": return "ws-color-fail";
    default: return "";
  }
}

export function riskLabel(risk: string): string {
  switch (risk.toLowerCase()) {
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    default: return risk;
  }
}

export function copyMetadataBlock(profile: RoutingProfile): string {
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

export function profileStatus(profile: RoutingProfile): "ready" | "warnings" {
  if (profile.missing_skills.length > 0 || profile.missing_agent) return "warnings";
  return "ready";
}
