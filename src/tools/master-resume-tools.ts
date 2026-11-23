// The two master résumé tools (PRD 01 §3): set_master_resume and get_master_resume.
//
// Each tool has three parts:
// - inputSchema: what the chat app's AI sees, so it knows which arguments to send. It only
//   describes the TYPES (a string, an optional number). If the real rules (200–60,000
//   characters...) were in it, the SDK would reject bad input itself with a long technical
//   message; instead our handler checks them with src/domain/master-resume.ts and answers with
//   one short sentence. The limits are still written in the description, so the AI knows them.
//   Trade-off: a wrong TYPE (no text, a number instead of a string, "2" instead of 2) is still
//   rejected by the SDK before our handler runs, with its own wording ("Input validation error:
//   ... expected string"). We accept that: keeping the types in the schema gives the AI correct
//   type hints, and only a misbehaving client sends the wrong type. Our sentences cover the rules
//   a person can actually break (too short, too long, not text).
// - outputSchema: the shape of a successful result. The SDK checks our structuredContent against it.
// - the handler: validate → database → result.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Queryable } from "../db/database.js";
import { explainDatabaseError } from "../db/db-errors.js";
import {
  getMasterResume,
  latestMasterResumeVersion,
  saveMasterResume,
  SaveCollisionError,
} from "../db/master-resume-repo.js";
import { countChars, parseMasterResumeText, parseResumeVersion } from "../domain/master-resume.js";

export interface ToolDeps {
  db: Queryable;
  /** Only used to name host:port in "can't reach the database" messages. Never shown in full. */
  databaseUrl: string;
}

const NOTHING_SAVED = "No master résumé is saved yet. Save one with set_master_resume.";

/** A successful result: the data as structured JSON, plus the same JSON as text for chat apps that only read text. */
export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

/** A failed result: one sentence the chat shows to the user. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Runs a handler and turns any unexpected error into a readable sentence. Without this the SDK
 * would show err.message, which is EMPTY when Postgres can't be reached (see db-errors.ts).
 */
export async function withReadableErrors(deps: ToolDeps, handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof SaveCollisionError) return fail(err.message);
    return fail(explainDatabaseError(err, deps.databaseUrl));
  }
}

export function registerMasterResumeTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "set_master_resume",
    {
      title: "Save master résumé",
      description:
        "Save the user's master résumé (plain text or Markdown, 200 to 60,000 characters). " +
        "Every save becomes a new version; older versions are kept. Send the full résumé text exactly as the user gave it.",
      inputSchema: { text: z.string().describe("The whole résumé as plain text or Markdown.") },
      outputSchema: {
        version: z.number().int().describe("The version number this save got (1 for the first save)."),
        chars: z.number().int().describe("How many characters were saved."),
      },
    },
    async ({ text }) =>
      withReadableErrors(deps, async () => {
        const parsed = parseMasterResumeText(text);
        if (!parsed.ok) return fail(parsed.message);

        const saved = await saveMasterResume(deps.db, parsed.text);
        return ok({ version: saved.version, chars: countChars(saved.text) });
      }),
  );

  server.registerTool(
    "get_master_resume",
    {
      title: "Get master résumé",
      description: "Get the saved master résumé: the latest version, or an older one if you pass its version number.",
      inputSchema: {
        version: z.number().optional().describe("Which version to get (1, 2, ...). Leave out for the latest."),
      },
      outputSchema: {
        version: z.number().int(),
        text: z.string(),
        saved_at: z.string().describe("When this version was saved (ISO 8601, UTC)."),
      },
    },
    async ({ version }) =>
      withReadableErrors(deps, async () => {
        const parsed = parseResumeVersion(version);
        if (!parsed.ok) return fail(parsed.message);

        const resume = await getMasterResume(deps.db, parsed.version);
        if (resume) {
          return ok({ version: resume.version, text: resume.text, saved_at: resume.savedAt.toISOString() });
        }

        // Asked for the latest and found none: nothing was saved when we looked. Answer from that
        // one snapshot, because a first save can commit before a second query runs.
        if (parsed.version === undefined) return fail(NOTHING_SAVED);

        // A specific version was not found: either nothing is saved at all, or that version doesn't exist.
        const latest = await latestMasterResumeVersion(deps.db);
        if (latest === undefined) return fail(NOTHING_SAVED);
        return fail(`There is no version ${parsed.version}. The latest is version ${latest}.`);
      }),
  );
}
