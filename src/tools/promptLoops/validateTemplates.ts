import { PROMPT_LOOP_GROUPS } from "./data";
import { composePrompt, PROMPT_OPTION_DEFS, togglePromptOption } from "./composer";

const PROMPT_GENERATOR_IDS = new Set([
  "prompt-start",
  "goal-start",
  "batch-start",
  "rewrite-existing",
]);

const PROMPT_FORMAT_IDS = new Set([
  ...PROMPT_GENERATOR_IDS,
  "prompt-verify",
  "prompt-merge",
  "goal-verify",
  "goal-merge",
  "batch-verify",
  "batch-merge",
]);

const EXPECTED_GROUPS = [
  ["Prompt", "prompt"],
  ["Goal Prompt", "goal-prompt"],
  ["Batch Prompt", "batch-prompt"],
  ["Rewrite", "rewrite"],
] as const;

const STALE_CONTRACT_PATTERNS = [
  /Operator metadata:/i,
  /Recommended executor:/i,
  /Recommended target:/i,
  /DB push:/i,
  /Risk\/cost notes:/i,
  /\bstandardprompt\b/i,
  /\bmasterprompt\b/i,
  /\bbatchprompt\b/i,
  /standard-prompt-kontrakt/i,
  /masterprompt-kontrakt/i,
  /batchprompt-kontrakt/i,
  /metadata ska bara ligga ovanför promptblocket/i,
] as const;

const STALE_CONTRACT_LABELS = [
  "Operator metadata:",
  "Recommended executor:",
  "Recommended target:",
  "DB push:",
  "Risk/cost notes:",
] as const;

/** Legacy wording that wrongly forbade executable skill-use lines in the prompt body. */
const FORBIDS_SKILLS_OUTSIDE_METADATA = [
  /lägg aldrig target tool\/model, skills/i,
  /never put skills in the (copy\/paste )?prompt/i,
  /skills must not appear in the copy\/paste prompt/i,
  /skills ska inte finnas i promptblocket/i,
];

const REQUIRES_SKILL_WEAVE = [
  /exact relevant skill names/i,
  /use diagnose\.\.\./i,
];

const REQUIRES_EXECUTABLE_BLOCK = /executable agent instructions only/i;
const REQUIRES_CLEAN_COPY_BLOCK = /one clean copy\/paste prompt block/i;
const REQUIRES_GOAL_CAP = /4000 characters/i;
const REQUIRES_GOAL_DEFAULT_LOOP = /maximum of 5 iterations by default/i;
const REQUIRES_GOAL_HARD_CAP = /never exceed 7 iterations/i;
const REQUIRES_GOAL_STOP_CONDITIONS =
  /failing baseline.*unavailable verification.*no high-confidence next issue/is;

function proposesPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (/föreslå/.test(lower) && /prompt/.test(lower)) return true;
  if (/skriv/.test(lower) && /prompt/.test(lower)) return true;
  if (/prompt|goal prompt|batch prompt/.test(lower)) return true;
  if (/nästa prompt|nästa rimliga/.test(lower)) return true;
  return false;
}

export function validatePromptLoopTemplates(): string[] {
  const errors: string[] = [];

  const actualGroups = PROMPT_LOOP_GROUPS.map(group => [group.group, group.key]);
  if (JSON.stringify(actualGroups) !== JSON.stringify(EXPECTED_GROUPS)) {
    errors.push("groups: must be Prompt, Goal Prompt, Batch Prompt, Rewrite with modern keys");
  }

  for (const group of PROMPT_LOOP_GROUPS) {
    for (const [label, key] of EXPECTED_GROUPS) {
      if (group.group === label && group.key !== key) {
        errors.push(`${group.group}: key must be "${key}"`);
      }
    }

    for (const item of group.items) {
      const prompt = item.prompt;

      for (const pattern of STALE_CONTRACT_PATTERNS) {
        if (pattern.test(prompt) || pattern.test(item.title) || pattern.test(item.meta) || pattern.test(group.group)) {
          errors.push(`${item.id}: contains stale prompt contract wording`);
          break;
        }
      }

      for (const pattern of FORBIDS_SKILLS_OUTSIDE_METADATA) {
        if (pattern.test(prompt)) {
          errors.push(`${item.id}: contradicts skill-weave (skills forbidden in prompt block)`);
        }
      }

      const needsSkillWeave =
        PROMPT_FORMAT_IDS.has(item.id) || proposesPrompt(prompt);

      if (needsSkillWeave && !REQUIRES_SKILL_WEAVE.some(p => p.test(prompt))) {
        errors.push(
          `${item.id}: must require exact skill names woven into executable instructions`,
        );
      }

      if (PROMPT_GENERATOR_IDS.has(item.id)) {
        for (const field of STALE_CONTRACT_LABELS) {
          if (!prompt.includes(field)) {
            continue;
          }
          errors.push(`${item.id}: must not include stale operator metadata field "${field}"`);
        }
        if (!REQUIRES_EXECUTABLE_BLOCK.test(prompt)) {
          errors.push(`${item.id}: must require executable agent instructions only`);
        }
        if (!REQUIRES_CLEAN_COPY_BLOCK.test(prompt)) {
          errors.push(`${item.id}: must require one clean copy/paste prompt block`);
        }
        if (/lägg aldrig target tool\/model, skills/i.test(prompt)) {
          errors.push(`${item.id}: bundled forbidden list still excludes skills from prompt block`);
        }
      }

      if (item.id === "goal-start") {
        if (!REQUIRES_GOAL_CAP.test(prompt)) {
          errors.push("goal-start: must cap copy/paste prompt block at 4000 characters");
        }
        if (!REQUIRES_GOAL_DEFAULT_LOOP.test(prompt)) {
          errors.push("goal-start: must require default max 5 iterations");
        }
        if (!REQUIRES_GOAL_HARD_CAP.test(prompt)) {
          errors.push("goal-start: must require hard cap 7 unless overridden");
        }
        if (!REQUIRES_GOAL_STOP_CONDITIONS.test(prompt)) {
          errors.push("goal-start: must include modern stop conditions");
        }
      }
    }
  }

  return errors;
}

export function validatePromptComposer(): string[] {
  const errors: string[] = [];
  const base = "BASE_TEMPLATE_PROMPT\nline two";

  if (composePrompt({ basePrompt: base }) !== base) {
    errors.push("composePrompt: empty input must return base prompt unchanged");
  }

  if (
    composePrompt({
      basePrompt: base,
      taskContext: "   ",
      selectedOptionIds: [],
    }) !== base
  ) {
    errors.push("composePrompt: whitespace-only task context must not inject");
  }

  const withRepo = composePrompt({
    basePrompt: base,
    repoContext: {
      label: "Demo",
      repo_slug: "owner/repo",
      current_branch: "feature/x",
      default_branch: "main",
    },
  });
  if (
    !withRepo.includes(base) ||
    !withRepo.includes("Demo") ||
    !withRepo.includes("owner/repo") ||
    !withRepo.includes("feature/x") ||
    !withRepo.includes("main")
  ) {
    errors.push("composePrompt: repo section must include base prompt and git-derived metadata");
  }
  const sensitivePatterns = [
    "Local path:",
    "/Users/",
    "https://github.com/",
    "git@github.com:",
    "ghp_",
    "github_pat_",
  ];
  for (const pattern of sensitivePatterns) {
    if (withRepo.includes(pattern)) {
      errors.push(`composePrompt: repo section must not include sensitive pattern "${pattern}"`);
    }
  }
  const unknownRepo = composePrompt({
    basePrompt: base,
    repoContext: {
      label: "Demo",
      repo_slug: null,
      current_branch: null,
      default_branch: null,
    },
  });
  if (!unknownRepo.includes("Repository: unknown")) {
    errors.push("composePrompt: missing repo slug must render Repository: unknown");
  }
  if (/Kretsverket|hardcoded/i.test(withRepo)) {
    errors.push("composePrompt: repo section must stay generic (no project names)");
  }

  const gitIds = PROMPT_OPTION_DEFS.filter(d => d.conflictGroup === "git-branch").map(d => d.id);
  let selected = new Set<string>();
  for (const id of gitIds) {
    selected = togglePromptOption(selected, id);
  }
  const gitSelected = [...selected].filter(id => gitIds.includes(id));
  if (gitSelected.length !== 1) {
    errors.push("togglePromptOption: git-branch group must allow only one active option");
  }

  const scopePair = ["visual-only", "no-ui-changes"] as const;
  selected = new Set();
  selected = togglePromptOption(selected, scopePair[0]);
  selected = togglePromptOption(selected, scopePair[1]);
  const scopeActive = [...selected].filter(id => (scopePair as readonly string[]).includes(id));
  if (scopeActive.length !== 1) {
    errors.push("togglePromptOption: scope-ui group must allow only one active option");
  }

  return errors;
}

export function runPromptLoopTemplateChecks(): void {
  const errors = [...validatePromptLoopTemplates(), ...validatePromptComposer()];
  if (errors.length > 0) {
    for (const err of errors) console.error(`FAIL: ${err}`);
    throw new Error(`Prompt Builder template check failed (${errors.length} issue(s))`);
  }
}
