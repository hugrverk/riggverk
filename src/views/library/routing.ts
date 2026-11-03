export function suggestWhen(description: string): string {
  const match = /\buse (?:it )?when\s+([\s\S]*?)(?:\.\s|$)/i.exec(description);
  const text = match?.[1]?.trim() ?? "";
  if (!text || /[`<]/.test(text)) return "";
  return text[0]!.toUpperCase() + text.slice(1);
}

export function routingLine(when: string, name: string): string {
  return `- ${when.trim()}: \`${name}\`.`;
}

export function ownWhen(lines: readonly string[], name: string): string | null {
  const suffix = `: \`${name}\`.`;
  for (const line of lines) {
    if (line.startsWith("- ") && line.endsWith(suffix)) {
      const when = line.slice(2, -suffix.length);
      if (!when.includes("`")) return when;
    }
  }
  return null;
}

export function whenProblem(when: string, name = ""): string {
  const invisible = /[\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]|[\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}]/u;
  const trimmed = when.trim();
  return invisible.test(when) || !trimmed || trimmed.startsWith("#") || /[`<]/.test(trimmed) || trimmed.includes("~~~") || Array.from(routingLine(when, name)).length > 240
    ? "Invalid routing description." : "";
}
