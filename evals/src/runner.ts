// Runs ONE case the way a chat app would, through the real tools:
//
//   add_job → get_fit_inputs → model → save_fit (the model's own call) → (on an error: one fix) → get_job
//
// What the model sees, call 1:
//   system:    HARNESS_SYSTEM_PROMPT (one neutral line; a chat app has its own system prompt)
//   tools:     the server's real get_fit_inputs and save_fit definitions (from tools/list)
//   user:      "Run a fit check on job N …"
//   assistant: a get_fit_inputs call  ← written by the harness
//   user:      get_fit_inputs' result as a tool_result, the exact text the MCP server returned
// The model then calls save_fit itself, with its own job_id, ref and result; the harness passes the
// call to the real tool and returns its answer as a tool_result (is_error on a refusal), so a
// refused answer gets the server's own error, as in a chat.
//
// Remaining differences from a real chat (DECISIONS, step 8): the first get_fit_inputs call is
// written by the harness rather than chosen by the model; only these two tools are offered; the
// system prompt is the harness's line, not a chat app's; and a reply in prose (no tool call) ends
// the case on purpose — a chat model that doesn't save the fit check hasn't done the job.
//
// Limits that make the cost estimate a true bound (step 8 re-check H1; LIMITS in args.ts):
// - a reply with more than LIMITS.maxToolCallsPerReply tool calls ends the case, nothing is run;
// - get_fit_inputs is never run again (its result is already in the conversation): short is_error;
// - save_fit only for the case's own job, and nothing more after the first successful save;
// - every tool result sent back is cut to LIMITS.maxToolResultChars characters.
import type Anthropic from "@anthropic-ai/sdk";
import { LIMITS } from "./args.js";
import type { EvalCase, Recommendation, StoredRequirement } from "./dataset.js";
import type { Harness, ToolResult } from "./harness.js";
import { ProviderError, type ModelProvider } from "./provider.js";
import type { AttemptLog, CaseRun, CriterionResult, SavedFit } from "./scoring.js";

export const HARNESS_SYSTEM_PROMPT = "You are an AI assistant connected to the user's job-search MCP server.";

export const fitRequest = (jobId: number): string =>
  `Run a fit check on job ${jobId} against my master résumé and criteria, and save it.`;

const SEEDED_CALL_ID = "toolu_harness_get_fit_inputs";

export interface RunCaseOptions {
  maxOutputTokens: number;
  /** Model calls per case (LIMITS.maxAttempts = 2). */
  maxCalls: number;
  /** Milliseconds since some fixed point (performance.now in real runs). */
  clock: () => number;
  /** True once the run is interrupted: no further model call is made. */
  stopped?: () => boolean;
}

/** A tool result as the model gets it: the text the MCP server returned. */
const resultText = (result: ToolResult): string => result.content.map((c) => c.text ?? "").join("\n");

const CUT = "… [cut]";

/** A tool result for the model, its text cut to LIMITS.maxToolResultChars. */
function toolResult(id: string, text: string, isError: boolean): Anthropic.ToolResultBlockParam {
  const content = text.length > LIMITS.maxToolResultChars ? text.slice(0, LIMITS.maxToolResultChars - CUT.length) + CUT : text;
  return isError ? { type: "tool_result", tool_use_id: id, content, is_error: true } : { type: "tool_result", tool_use_id: id, content };
}

export const ALREADY_HAVE_INPUTS = "get_fit_inputs already ran for this fit check; its result is above.";

/**
 * Never throws: whatever goes wrong, the attempts so far (and the tokens they billed) are kept in
 * the returned run (review R5). `fatal` tells main.ts to stop the whole run.
 */
export async function runCase(
  harness: Harness,
  evalCase: EvalCase,
  index: number,
  provider: ModelProvider,
  options: RunCaseOptions,
): Promise<CaseRun> {
  const attempts: AttemptLog[] = [];
  let jobId: number | null = null;
  const done = (saved: SavedFit | null, error: string | null, fatal = false): CaseRun => ({
    caseId: evalCase.id,
    jobId,
    attempts,
    saved,
    error,
    fatal,
  });

  try {
    jobId = await harness.addJob(evalCase, index);
    const inputs = await harness.call("get_fit_inputs", { job_id: jobId });
    if (inputs.isError) return done(null, `get_fit_inputs failed: ${resultText(inputs)}`);

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: fitRequest(jobId) },
      { role: "assistant", content: [{ type: "tool_use", id: SEEDED_CALL_ID, name: "get_fit_inputs", input: { job_id: jobId } }] },
      // Whole, never cut: this is the fit check's input, already counted in the first request.
      { role: "user", content: [{ type: "tool_result", tool_use_id: SEEDED_CALL_ID, content: resultText(inputs) }] },
    ];
    const offered = new Set(harness.tools.map((t) => t.name));

    for (let call = 1; call <= options.maxCalls; call++) {
      if (options.stopped?.()) return done(null, "Interrupted.");
      const started = options.clock();
      let reply;
      try {
        reply = await provider.complete({
          caseId: evalCase.id,
          call,
          system: HARNESS_SYSTEM_PROMPT,
          tools: harness.tools,
          messages,
          maxOutputTokens: options.maxOutputTokens,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        attempts.push({ latencyMs: options.clock() - started, ...error.usage, saveError: null, reply: [] });
        return done(null, error.message, error.fatal);
      }
      const attempt: AttemptLog = {
        latencyMs: options.clock() - started,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        saveError: null,
        // Kept for reading later; thinking blocks are left out of the results file.
        reply: reply.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking"),
      };
      attempts.push(attempt);
      messages.push({ role: "assistant", content: reply.content });

      const calls = reply.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use");
      if (calls.length === 0) return done(null, "The model answered without calling save_fit.");
      if (calls.length > LIMITS.maxToolCallsPerReply) {
        return done(null, `The model made ${calls.length} tool calls in one reply; at most ${LIMITS.maxToolCallsPerReply} are run, so the case stops.`);
      }

      let saved = false;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of calls) {
        const args = typeof use.input === "object" && use.input !== null ? (use.input as Record<string, unknown>) : {};
        if (use.name === "get_fit_inputs") {
          results.push(toolResult(use.id, ALREADY_HAVE_INPUTS, true));
        } else if (!offered.has(use.name)) {
          results.push(toolResult(use.id, `There is no tool named "${use.name}" here.`, true));
        } else if (saved) {
          results.push(toolResult(use.id, "The fit check is already saved; this call was not run.", true));
        } else if (args.job_id !== jobId) {
          results.push(toolResult(use.id, `This fit check is for job ${jobId}; save_fit was not run for job ${String(args.job_id)}.`, true));
        } else {
          const result = await harness.call(use.name, args);
          const text = resultText(result);
          if (result.isError) attempt.saveError = text;
          else saved = true;
          results.push(toolResult(use.id, text, result.isError === true));
        }
      }
      if (saved) return done(await readSavedFit(harness, jobId), null);
      messages.push({ role: "user", content: results });
    }
    const lastError = attempts.at(-1)?.saveError;
    return done(
      null,
      `No fit check was saved after ${options.maxCalls} model calls${lastError ? `; the last save_fit error: ${lastError}` : "."}`,
    );
  } catch (error) {
    return done(null, error instanceof Error ? error.message : String(error));
  }
}

/** The stored fit check, read back through get_job (what the user would see). */
async function readSavedFit(harness: Harness, jobId: number): Promise<SavedFit> {
  const job = await harness.callOk("get_job", { id: jobId });
  const fit = job.latest_fit as {
    jd_match_pct: number;
    strict_jd_match_pct?: number | null;
    criteria_match_pct: number | null;
    recommendation: Recommendation;
    weak_go: boolean;
    quotes_dropped: number;
    suggestions_dropped?: number | null;
    make_explicit?: { make_explicit_quote: string }[];
    requirements: StoredRequirement[];
    red_flags: string[];
    criteria: CriterionResult[];
  };
  return {
    jdPct: fit.jd_match_pct,
    // Read defensively: a stand-in get_job (unit tests) or an older server may leave the step-11 fields out.
    strictPct: fit.strict_jd_match_pct ?? null,
    criteriaPct: fit.criteria_match_pct,
    recommendation: fit.recommendation,
    weakGo: fit.weak_go,
    requirements: fit.requirements,
    droppedQuotes: fit.quotes_dropped,
    suggestionQuotes: (fit.make_explicit ?? []).map((s) => s.make_explicit_quote),
    droppedSuggestions: fit.suggestions_dropped ?? 0,
    redFlags: fit.red_flags,
    criteria: fit.criteria.map(({ label, status, reason }) => ({ label, status, reason })),
  };
}
