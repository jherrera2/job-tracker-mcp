// The three criteria tools (PRD 01 §3): list_criteria_suggestions, set_criteria and get_criteria.
//
// Same pattern as src/tools/master-resume-tools.ts: the inputSchema only describes TYPES, the real
// rules (1–5 items, lengths, duplicate labels) are checked by src/domain/criteria.ts so the user
// gets one plain sentence, and the limits are written in the description so the AI knows them.
// A wrong type gets the SDK's own message (DECISIONS.md, PR #2 decision 2).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCriteria, replaceCriteria, type SavedCriterion } from "../db/criteria-repo.js";
import {
  CRITERIA_SUGGESTIONS,
  MAX_CRITERIA,
  MAX_DETAIL_CHARS,
  MAX_LABEL_CHARS,
  MIN_CRITERIA,
  parseCriteria,
} from "../domain/criteria.js";
import { fail, ok, withReadableErrors, type ToolDeps } from "./master-resume-tools.js";

const SavedCriterionSchema = z.object({
  position: z.number().int().describe("1 is the most important."),
  label: z.string(),
  detail: z.string().describe("The user's own words."),
  updated_at: z.string().describe("When this set was saved (ISO 8601, UTC)."),
});

const criteriaOutput = {
  criteria: z.array(SavedCriterionSchema).describe("The saved criteria in position order."),
};

function toOutput(criteria: SavedCriterion[]) {
  return {
    criteria: criteria.map((c) => ({
      position: c.position,
      label: c.label,
      detail: c.detail,
      updated_at: c.updatedAt.toISOString(),
    })),
  };
}

export function registerCriteriaTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_criteria_suggestions",
    {
      title: "List criteria suggestions",
      description:
        "List common job-search criteria (pay floor, fully remote, ...) the user can pick from for their top 5. " +
        "Each has an example detail. The user may also write their own criteria instead.",
      inputSchema: {},
      outputSchema: {
        suggestions: z.array(z.object({ key: z.string(), label: z.string(), example: z.string() })),
      },
    },
    () => ok({ suggestions: CRITERIA_SUGGESTIONS.map(({ key, label, example }) => ({ key, label, example })) }),
  );

  server.registerTool(
    "set_criteria",
    {
      title: "Save top criteria",
      description:
        `Save the user's top criteria for a job: ${MIN_CRITERIA} to ${MAX_CRITERIA} items, most important first. ` +
        `Each has a short label (up to ${MAX_LABEL_CHARS} characters) and a detail in the user's own words ` +
        `(up to ${MAX_DETAIL_CHARS} characters). Labels must be different. ` +
        "Saving REPLACES the whole saved set, so send every criterion the user wants to keep.",
      inputSchema: {
        criteria: z
          .array(
            z.object({
              label: z.string().describe('A short name, e.g. "Pay floor".'),
              detail: z.string().describe('What it means to the user, in their words, e.g. "Base pay of at least $140k".'),
            }),
          )
          .describe("The full set, in order of importance."),
      },
      outputSchema: criteriaOutput,
    },
    async ({ criteria }) =>
      withReadableErrors(deps, async () => {
        const parsed = parseCriteria(criteria);
        if (!parsed.ok) return fail(parsed.message);

        const saved = await replaceCriteria(deps.db, parsed.criteria);
        return ok(toOutput(saved));
      }),
  );

  server.registerTool(
    "get_criteria",
    {
      title: "Get top criteria",
      description: "Get the user's saved top criteria in order of importance (an empty list if none are saved yet).",
      inputSchema: {},
      outputSchema: criteriaOutput,
    },
    async () => withReadableErrors(deps, async () => ok(toOutput(await getCriteria(deps.db)))),
  );
}
