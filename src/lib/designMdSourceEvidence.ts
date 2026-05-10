import type { DesignMdSourceConfidence, DesignMdSourceEvidence, DesignMdSourceType } from "./designMdPreviewParser";

export function sourceEvidence(
  sourceType: DesignMdSourceType,
  sourcePath: string,
  confidence: DesignMdSourceConfidence,
  text?: string,
): DesignMdSourceEvidence {
  const compact = text?.replace(/\s+/g, " ").trim();
  return {
    sourceType,
    sourcePath,
    confidence,
    ...(compact ? { text: compact.slice(0, 180) } : {}),
  };
}

export function evidenceLabel(evidence: DesignMdSourceEvidence | undefined): string {
  if (!evidence) return "derived-fallback";
  return `${evidence.sourcePath} (${evidence.confidence})`;
}
