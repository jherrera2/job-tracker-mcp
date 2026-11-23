// The small interface the runner talks to, so the model behind it can be swapped:
// - RecordedProvider (here): answers from evals/recorded/<case>.json. Used by --dry-run and the
//   tests, so they never touch the network and cost nothing.
// - the Anthropic provider (anthropic-provider.ts): the official SDK, for a real run.
//
// Messages and content blocks use the Anthropic SDK's own types: the conversation has tool calls
// in it (get_fit_inputs' result, the model's save_fit call), as in a real chat.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export interface ModelRequest {
  /** Which case and which model call this is (1-based); only the recorded provider uses them. */
  caseId: string;
  call: number;
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  /** max_tokens for this call (thinking included). */
  maxOutputTokens: number;
}

export interface ModelReply {
  /** Every block the model sent, thinking included: it is replayed unchanged on the next call. */
  content: Anthropic.ContentBlockParam[];
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProvider {
  readonly name: "anthropic" | "recorded";
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}

/**
 * A provider failure. `fatal` stops the whole run (bad key, unknown model: every case would fail
 * the same way); otherwise only this case fails and the run goes on.
 */
export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly fatal: boolean,
    /** Tokens billed even though the call failed (a refusal or a cut-off answer still costs). */
    readonly usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
  ) {
    super(message);
  }
}

interface Recording {
  /** One entry per model call: an answer object (sent as a save_fit call) or plain reply text. */
  attempts: unknown[];
}

/** job_id and ref from the get_fit_inputs result in the conversation, as a model would copy them. */
function inputsFromConversation(messages: readonly Anthropic.MessageParam[]): { job_id: unknown; ref: unknown } {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && typeof block.content === "string") {
        try {
          const parsed = JSON.parse(block.content) as { job_id?: unknown; ref?: unknown };
          if (parsed.ref !== undefined) return { job_id: parsed.job_id, ref: parsed.ref };
        } catch {
          // not get_fit_inputs' JSON (e.g. a save_fit error sentence)
        }
      }
    }
  }
  throw new Error("The conversation has no get_fit_inputs result to read job_id and ref from.");
}

export class RecordedProvider implements ModelProvider {
  readonly name = "recorded";
  readonly model = "recorded";

  constructor(private readonly dir: string) {}

  complete(request: ModelRequest): Promise<ModelReply> {
    const file = join(this.dir, `${request.caseId}.json`);
    if (!existsSync(file)) {
      return Promise.reject(new ProviderError(`No recorded answer for case "${request.caseId}" (${file}).`, false));
    }
    const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
    const answer = recording.attempts[request.call - 1];
    if (answer === undefined) {
      return Promise.reject(new ProviderError(`No recorded answer for case "${request.caseId}", call ${request.call}.`, false));
    }
    const content: Anthropic.ContentBlockParam[] =
      typeof answer === "string"
        ? [{ type: "text", text: answer }]
        : [
            {
              type: "tool_use",
              id: `toolu_recorded_${request.caseId}_${request.call}`,
              name: "save_fit",
              input: { ...inputsFromConversation(request.messages), result: answer, model: this.model },
            },
          ];
    return Promise.resolve({ content, inputTokens: 0, outputTokens: 0 });
  }
}
