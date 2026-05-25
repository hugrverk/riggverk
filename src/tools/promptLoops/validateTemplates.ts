import { PROMPT_LOOP_GROUPS } from "./data";
import { composePrompt, PROMPT_OPTION_DEFS, togglePromptOption } from "./composer";

/** Templates that ask ChatGPT to emit operator metadata + a copy/paste prompt body. */
const PROMPT_GENERATOR_IDS = new Set([
  "standard-start",
  "master-start",
  "batch-start",
  "rewrite-existing",
]);

/** Templates that may propose a follow-up prompt in standard format. */
const PROMPT_FORMAT_IDS = new Set([
  ...PROMPT_GENERATOR_IDS,
  "standard-verify",
  "standard-merge",
  "master-verify",
  "master-merge",
  "batch-verify",
  "batch-merge",
]);

const OPERATOR_METADATA_FIELDS = [
  "Operator metadata:",
  "Recommended executor:",
  "Relevant skills:",
  "DB push:",
  "Migration:",
  "Branch:",
  "Risk/cost notes:",
  "Copy/paste prompt:",
] as const;

/** Legacy wording that wrongly forbade executable skill-use lines in the prompt body. */
const FORBIDS_SKILLS_OUTSIDE_METADATA = [
  /lägg aldrig target tool\/model, skills/i,
  /never put skills in the (copy\/paste )?prompt/i,
  /skills must not appear in the copy\/paste prompt/i,
  /skills ska inte finnas i promptblocket/i,
];

const REQUIRES_SKILL_WEAVE = [
  /väva in exakta skill-namn/i,
  /use diagnose\.\.\./i,
];

const REQUIRES_EXECUTABLE_BLOCK = /copy\/paste prompt-blocket ska vara exekverbara/i;

const REQUIRES_METADATA_SEPARATION =
  /lägg aldrig operator metadata-etiketter/i;

function proposesPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (prompt.includes("Copy/paste prompt:")) return true;
  if (/föreslå/.test(lower) && /prompt/.test(lower)) return true;
  if (/skriv/.test(lower) && /prompt/.test(lower)) return true;
  if (/standardprompt|masterprompt|batchprompt/.test(lower)) return true;
  if (/nästa prompt|nästa rimliga/.test(lower)) return true;
  return false;
}

export function validatePromptLoopTemplates(): string[] {
  const errors: string[] = [];

  for (const group of PROMPT_LOOP_GROUPS) {
    for (const item of group.items) {
      const prompt = item.prompt;

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
        for (const field of OPERATOR_METADATA_FIELDS) {
          if (!prompt.includes(field)) {
            errors.push(`${item.id}: missing operator metadata field "${field}"`);
          }
        }
        if (!REQUIRES_EXECUTABLE_BLOCK.test(prompt)) {
          errors.push(`${item.id}: must require executable English copy/paste prompt block`);
        }
        if (!REQUIRES_METADATA_SEPARATION.test(prompt)) {
          errors.push(`${item.id}: must forbid operator metadata labels inside prompt block`);
        }
        if (/lägg aldrig target tool\/model, skills/i.test(prompt)) {
          errors.push(`${item.id}: bundled forbidden list still excludes skills from prompt block`);
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
    throw new Error(`Prompt Loops template check failed (${errors.length} issue(s))`);
  }
}
