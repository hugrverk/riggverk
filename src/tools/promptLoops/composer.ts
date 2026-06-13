export const NO_REPO_CONTEXT_VALUE = "";

export interface PromptOptionDef {
  id: string;
  label: string;
  /** Visible constraint line injected when selected. */
  line: string;
  /** Mutually exclusive with other options in the same group. */
  conflictGroup?: "git-branch" | "scope-ui";
}

export const PROMPT_OPTION_DEFS: readonly PromptOptionDef[] = [
  {
    id: "docs-only",
    label: "Docs only",
    line: "Hard constraint: docs only. Do not change application code unless required for the docs task.",
  },
  {
    id: "visual-only",
    label: "Visual-only",
    line: "Hard constraint: visual-only changes (layout, styling, copy). No logic or behavior changes.",
    conflictGroup: "scope-ui",
  },
  {
    id: "no-ui-changes",
    label: "No UI changes",
    line: "Hard constraint: no UI changes.",
    conflictGroup: "scope-ui",
  },
  {
    id: "no-behavior-changes",
    label: "No behavior changes",
    line: "Hard constraint: no behavior changes.",
  },
  {
    id: "no-migration",
    label: "No migration",
    line: "Hard constraint: no database or schema migrations.",
  },
  {
    id: "no-persistence-changes",
    label: "No persistence changes",
    line: "Hard constraint: no persistence or settings storage changes.",
  },
  {
    id: "new-branch",
    label: "New branch",
    line: "Git: create and work on a new branch for this task.",
    conflictGroup: "git-branch",
  },
  {
    id: "stay-current-branch",
    label: "Stay on current branch",
    line: "Git: stay on the current branch; do not create a new branch.",
    conflictGroup: "git-branch",
  },
  {
    id: "direct-main",
    label: "Direct main",
    line: "Git: work directly on main (only if repo policy and git state allow it).",
    conflictGroup: "git-branch",
  },
  {
    id: "focused-check",
    label: "Focused check",
    line: "Verification: run the narrowest focused check that falsifies the change.",
  },
  {
    id: "full-check",
    label: "Full check",
    line: "Verification: run the broader project check set appropriate to the change.",
  },
  {
    id: "final-report",
    label: "Final report",
    line: "Reporting: end with a concise final report (changed, verified, not verified, risk, next).",
  },
] as const;

const OPTION_BY_ID = new Map(PROMPT_OPTION_DEFS.map(def => [def.id, def]));

/** Sanitized repo section input for composed prompts (no local paths or raw remotes). */
export interface PromptRepoContextSection {
  label: string;
  repo_slug: string | null;
  current_branch: string | null;
  default_branch: string | null;
  warnings?: readonly string[];
}

export interface ComposePromptInput {
  basePrompt: string;
  repoContext?: PromptRepoContextSection | null;
  taskContext?: string;
  selectedOptionIds?: readonly string[];
}

function displayOrUnknown(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "unknown";
}

function formatRepoContextSection(ctx: PromptRepoContextSection): string {
  const lines = [
    "Repository context selected from saved Repo Dashboard entries:",
    `- Label: ${ctx.label}`,
    `- Repository: ${displayOrUnknown(ctx.repo_slug)}`,
    `- Current branch: ${displayOrUnknown(ctx.current_branch)}`,
    `- Default branch: ${displayOrUnknown(ctx.default_branch)}`,
  ];
  if (ctx.repo_slug == null) {
    lines.push(
      "- Note: repository identity could not be determined from git; inspect remotes and repo-local docs.",
    );
  }
  lines.push(
    "The selected repo metadata is only a starting context. Inspect repository reality, repo-local docs, scripts, remotes, and current git state before making claims or edits.",
  );
  return lines.join("\n");
}

function formatTaskContextSection(taskContext: string): string {
  return ["Task / context:", taskContext.trim()].join("\n");
}

function formatOptionsSection(selectedIds: readonly string[]): string {
  const lines = selectedIds
    .map(id => OPTION_BY_ID.get(id)?.line)
    .filter((line): line is string => Boolean(line));
  if (!lines.length) return "";
  return ["Prompt options (hard constraints):", ...lines.map(line => `- ${line}`)].join("\n");
}

/** Pure deterministic composer. Returns exactly basePrompt when nothing is active. */
export function composePrompt(input: ComposePromptInput): string {
  const { basePrompt, repoContext, taskContext, selectedOptionIds = [] } = input;
  const task = taskContext?.trim() ?? "";
  const options = selectedOptionIds.filter(id => OPTION_BY_ID.has(id));

  if (!repoContext && !task && options.length === 0) {
    return basePrompt;
  }

  const sections: string[] = [];
  if (repoContext) sections.push(formatRepoContextSection(repoContext));
  if (task) sections.push(formatTaskContextSection(task));
  sections.push(basePrompt);
  const optionsBlock = formatOptionsSection(options);
  if (optionsBlock) sections.push(optionsBlock);

  return sections.join("\n\n");
}

/** Toggle selection; deselects conflicting options in the same group. */
export function togglePromptOption(
  selected: ReadonlySet<string>,
  optionId: string,
): Set<string> {
  const def = OPTION_BY_ID.get(optionId);
  if (!def) return new Set(selected);

  const next = new Set(selected);
  if (next.has(optionId)) {
    next.delete(optionId);
    return next;
  }

  if (def.conflictGroup) {
    for (const other of PROMPT_OPTION_DEFS) {
      if (other.conflictGroup === def.conflictGroup && other.id !== optionId) {
        next.delete(other.id);
      }
    }
  }
  next.add(optionId);
  return next;
}

export function isOptionDisabled(
  selected: ReadonlySet<string>,
  optionId: string,
): { disabled: boolean; reason?: string } {
  const def = OPTION_BY_ID.get(optionId);
  if (!def?.conflictGroup || selected.has(optionId)) {
    return { disabled: false };
  }
  for (const other of PROMPT_OPTION_DEFS) {
    if (
      other.conflictGroup === def.conflictGroup &&
      other.id !== optionId &&
      selected.has(other.id)
    ) {
      return {
        disabled: true,
        reason: `Conflicts with ${other.label}. Deselect it first.`,
      };
    }
  }
  return { disabled: false };
}

export function hasActiveComposerState(input: {
  repoEntryId: string;
  taskContext: string;
  selectedOptionIds: ReadonlySet<string>;
}): boolean {
  return (
    input.repoEntryId !== NO_REPO_CONTEXT_VALUE ||
    input.taskContext.trim().length > 0 ||
    input.selectedOptionIds.size > 0
  );
}
