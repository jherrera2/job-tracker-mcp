// The three prompt tools (PRD 01 §2 story 6, §3): get_prompt, update_prompt and reset_prompt.
//
// Same pattern as src/tools/master-resume-tools.ts: the inputSchema only describes TYPES (a plain
// string for the name, not an enum), so an unknown name reaches our handler and gets one short
// sentence listing the real names instead of the SDK's validation message. The names and limits
// are written in the descriptions, so the AI knows them.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPrompt, resetPrompt, savePrompt, type SavedPrompt } from "../db/prompts-repo.js";
import { formatNumber } from "../domain/master-resume.js";
import { MAX_PROMPT_CHARS, PROMPT_NAMES, parsePromptName, parsePromptText } from "../domain/prompts.js";
import { fail, ok, withReadableErrors, type ToolDeps } from "./master-resume-tools.js";

const NAMES = PROMPT_NAMES.join(", ");

const nameInput = z.string().describe(`Which prompt. One of: ${NAMES}.`);

const promptOutput = {
  name: z.string(),
  version: z.number().int().describe("The version number. Version 1 is the shipped default, saved the first time the prompt was used."),
  text: z.string(),
  is_default: z.boolean().describe("True when this version was saved from a shipped default (possibly from an earlier release; reset_prompt saves the current one), false when it is the user's edit."),
  saved_at: z.string().describe("When this version was saved (ISO 8601, UTC)."),
};

function toOutput(prompt: SavedPrompt) {
  return {
    name: prompt.name,
    version: prompt.version,
    text: prompt.text,
    is_default: prompt.isDefault,
    saved_at: prompt.savedAt.toISOString(),
  };
}

export function registerPromptTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_prompt",
    {
      title: "Get an AI prompt",
      description:
        `Get the current text of one of the AI prompts this server uses (${NAMES}), with its version number. ` +
        "The fit_check prompt holds the instructions for judging how well a job fits the user.",
      inputSchema: { name: nameInput },
      outputSchema: promptOutput,
    },
    async ({ name }) =>
      withReadableErrors(deps, async () => {
        const parsedName = parsePromptName(name);
        if (!parsedName.ok) return fail(parsedName.message);
        return ok(toOutput(await getPrompt(deps.db, parsedName.name)));
      }),
  );

  server.registerTool(
    "update_prompt",
    {
      title: "Edit an AI prompt",
      description:
        `Save new text for one of the AI prompts (${NAMES}), 1 to ${formatNumber(MAX_PROMPT_CHARS)} characters. ` +
        "Every edit becomes a new version; older versions are kept. Send the WHOLE prompt, not only the changed part. " +
        "An edit can change the wording and the judgment, but not the shape of the answer: the answer format is checked by code.",
      inputSchema: { name: nameInput, text: z.string().describe("The full new prompt text.") },
      outputSchema: promptOutput,
    },
    async ({ name, text }) =>
      withReadableErrors(deps, async () => {
        const parsedName = parsePromptName(name);
        if (!parsedName.ok) return fail(parsedName.message);
        const parsedText = parsePromptText(text);
        if (!parsedText.ok) return fail(parsedText.message);
        return ok(toOutput(await savePrompt(deps.db, parsedName.name, parsedText.text)));
      }),
  );

  server.registerTool(
    "reset_prompt",
    {
      title: "Reset an AI prompt",
      description:
        `Put one of the AI prompts (${NAMES}) back to the shipped default. ` +
        "The default is saved as a new version, so the user's edits stay in the history.",
      inputSchema: { name: nameInput },
      outputSchema: promptOutput,
    },
    async ({ name }) =>
      withReadableErrors(deps, async () => {
        const parsedName = parsePromptName(name);
        if (!parsedName.ok) return fail(parsedName.message);
        return ok(toOutput(await resetPrompt(deps.db, parsedName.name)));
      }),
  );
}
