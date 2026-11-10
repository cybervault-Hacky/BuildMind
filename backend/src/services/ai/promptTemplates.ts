/* ==========================================================================
   BuildMind API — services/ai/promptTemplates.ts
   Prompts for the build stages, kept out of the orchestrator so the workflow
   reads as workflow.

   Every prompt demands JSON and names the exact schema keys. Combined with
   `json: true` and Zod validation on the way back, this is what makes a
   malformed answer a safe failure rather than a corruption.

   The prompts also state, in the model's own instructions, that it must not
   emit shell commands or absolute paths — but that instruction is *not* a
   security control. The control is the validator. Prompt text is advisory.
   ========================================================================== */

export const SYSTEM_UNDERSTANDING = `You are BuildMind's specification stage for a Roblox game builder.
Return ONLY a JSON object with exactly these keys:
  name (string, <=80),
  genre (string, <=60),
  coreLoop (string, <=400),
  mechanics (array of 1-20 short strings),
  systems (array of 0-20 short strings),
  map (string, <=600),
  playerExperience (string, <=600),
  assets (array of 0-40 short strings),
  scripts (array of 0-40 short strings),
  dependencies (array of 0-40 short strings),
  validationRules (array of 0-40 short strings).
No prose, no markdown, no code fences. Do not include any other keys.`;

export const SYSTEM_PLANNING = `You are BuildMind's planning stage.
Return ONLY a JSON object with exactly these keys:
  summary (string, <=600),
  steps (array of 1-20 objects, each { "title": string <=120, "detail": string <=400 }),
  files (array of planned file paths, each a relative path like "Main.luau";
         no leading slash, no "..", no backslashes, <=40 entries).
No prose, no markdown, no code fences. Do not include any other keys.`;

export const SYSTEM_BUILDING = `You are BuildMind's construction stage for a Roblox project.
Return ONLY a JSON object with exactly this key:
  artifacts (array of 1-40 objects).
Each artifact object has exactly:
  path (relative path such as "Main.luau" or "manifest.project.json"),
  type (one of "script","asset","manifest","config","doc"),
  content (the file text),
  metadata (an object; may be empty).
Use only .luau or .lua for scripts. Include one manifest artifact whose path
ends with ".project.json" containing valid JSON with a "name" string and a
"tree" object. Never emit absolute paths, "..", backslashes or shell commands.
No prose, no markdown, no code fences. Do not include any other keys.`;

export const SYSTEM_FIXING = `You are BuildMind's repair stage.
You are given a list of concrete validation failures and the artifacts that
produced them. Return ONLY a JSON object with exactly these keys:
  diagnosis (string, <=600, describing the fix you made),
  artifacts (array of 1-40 corrected artifact objects, same shape as the
             construction stage).
Correct only what is needed to make validation pass. Same path rules apply.
No prose, no markdown, no code fences. Do not include any other keys.`;

export function understandingPrompt(prompt: string): string {
  return `Game idea from the user:\n"""\n${prompt}\n"""\n\nProduce the specification JSON.`;
}

export function planningPrompt(prompt: string, specificationJson: string): string {
  return `Game idea from the user:\n"""\n${prompt}\n"""\n\nValidated specification:\n${specificationJson}\n\nProduce the plan JSON.`;
}

export function buildingPrompt(prompt: string, specificationJson: string, planJson: string): string {
  return `Game idea from the user:\n"""\n${prompt}\n"""\n\nSpecification:\n${specificationJson}\n\nPlan:\n${planJson}\n\nProduce the artifacts JSON.`;
}

export function fixingPrompt(issues: string[], artifactsJson: string): string {
  const list = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
  return `Validation failures to correct:\n${list}\n\nCurrent artifacts:\n${artifactsJson}\n\nProduce the fix JSON.`;
}
