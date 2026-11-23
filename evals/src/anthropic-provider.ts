// The real model, through the official Anthropic SDK. Only `npm run evals -- --yes` creates it
// (main.ts); the tests pass a stand-in fetch, so nothing leaves the machine.
//
// Choices (DECISIONS, "Step 8 — proposed"):
// - Plain Messages API call, not streaming: max_tokens is at most 16,000, well inside the SDK's
//   non-streaming timeout. The request body is exactly model, max_tokens, system, tools and
//   messages (+ output_config.effort with --effort); a test pins it.
// - baseURL is fixed to https://api.anthropic.com, so an ANTHROPIC_BASE_URL left in the shell
//   can't send the key somewhere else. maxRetries 0: the SDK does not retry on its own; a failed
//   call fails that case and the run goes on (the runner handles it), so spend stays predictable.
// - Thinking is left at the model's default (adaptive on current models); `effort` is sent only
//   when --effort is given. No temperature: current models reject sampling parameters.
// - No server-side refusal fallback: a fallback would quietly answer with a DIFFERENT model and
//   the eval would measure the wrong thing. A refusal fails the case instead.
// - The key is passed in by main.ts and never logged. Error messages are passed through redact(),
//   because an API error can echo request details back.
import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "./args.js";
import { ProviderError, type ModelProvider } from "./provider.js";
import { redact } from "./redact.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: Effort | null;
  /** Tests only: a stand-in for the network. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export const ANTHROPIC_API_URL = "https://api.anthropic.com";

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  const client = new Anthropic({ apiKey: options.apiKey, baseURL: ANTHROPIC_API_URL, fetch: options.fetch, maxRetries: 0 });
  const clean = (message: string) => redact(message, [options.apiKey]);

  return {
    name: "anthropic",
    model: options.model,
    async complete(request) {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: options.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          tools: request.tools,
          messages: request.messages,
          ...(options.effort ? { output_config: { effort: options.effort } } : {}),
        });
      } catch (error) {
        // Most specific first. Errors that will repeat for every case stop the run.
        if (
          error instanceof Anthropic.AuthenticationError ||
          error instanceof Anthropic.PermissionDeniedError ||
          error instanceof Anthropic.NotFoundError ||
          error instanceof Anthropic.BadRequestError
        ) {
          throw new ProviderError(clean(`The API refused the request (${error.status}): ${error.message}`), true);
        }
        if (error instanceof Anthropic.APIError) {
          // 429 / 5xx / network: this case fails, the run goes on.
          throw new ProviderError(clean(`API error ${String(error.status ?? "")}: ${error.message}`), false);
        }
        throw new ProviderError(clean(error instanceof Error ? error.message : String(error)), false);
      }

      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      if (response.stop_reason === "refusal") {
        throw new ProviderError("The model refused to answer (stop_reason: refusal).", false, usage);
      }
      if (response.stop_reason === "max_tokens") {
        throw new ProviderError(`The answer was cut off at max_tokens (${request.maxOutputTokens}).`, false, usage);
      }
      // Response blocks are valid request blocks, so the whole reply can be replayed as it came.
      return { content: response.content, ...usage };
    },
  };
}
