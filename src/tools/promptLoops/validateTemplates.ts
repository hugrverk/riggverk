import { PROMPT_LOOP_GROUPS } from "./data";

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

export function runPromptLoopTemplateChecks(): void {
  const errors = validatePromptLoopTemplates();
  if (errors.length > 0) {
    for (const err of errors) console.error(`FAIL: ${err}`);
    throw new Error(`Prompt Loops template check failed (${errors.length} issue(s))`);
  }
}
