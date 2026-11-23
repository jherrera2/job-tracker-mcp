// The two model providers (evals/src/provider.ts, evals/src/anthropic-provider.ts). The Anthropic
// one is tested through the official SDK with a stand-in fetch, so no request leaves the machine.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../../evals/src/anthropic-provider.js";
import { ProviderError, RecordedProvider, type ModelRequest } from "../../../evals/src/provider.js";

const SECRET = "sk-ant-api03-FAKE-KEY-FOR-TESTS-ONLY-abcdef";

const TOOLS = [
  { name: "save_fit", description: "Save it.", input_schema: { type: "object" as const, properties: { job_id: { type: "number" } } } },
];

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  caseId: "c1",
  call: 1,
  system: "System text.",
  tools: TOOLS,
  messages: [{ role: "user", content: "The prompt." }],
  maxOutputTokens: 1234,
  ...over,
});

describe("RecordedProvider", () => {
  const dir = mkdtempSync(join(tmpdir(), "evals-recorded-"));
  writeFileSync(join(dir, "c1.json"), JSON.stringify({ attempts: [{ recommendation: "go" }, "raw text answer"] }));
  // What the harness puts before the first model call: get_fit_inputs' result as a tool_result.
  const seeded = request({
    messages: [
      { role: "user", content: "Check job 7." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_fit_inputs", input: { job_id: 7 } }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: JSON.stringify({ job_id: 7, ref: "fit1-j7-p1-m1-c0123456789abcdef", prompt: "…" }) }],
      },
    ],
  });

  it("answers the way a model in a chat would: a save_fit call with job_id and ref read from the conversation", async () => {
    const reply = await new RecordedProvider(dir).complete(seeded);
    expect(reply).toEqual({
      content: [
        {
          type: "tool_use",
          id: "toolu_recorded_c1_1",
          name: "save_fit",
          input: { job_id: 7, ref: "fit1-j7-p1-m1-c0123456789abcdef", result: { recommendation: "go" }, model: "recorded" },
        },
      ],
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("returns a recorded STRING as plain text (no tool call)", async () => {
    const reply = await new RecordedProvider(dir).complete({ ...seeded, call: 2 });
    expect(reply.content).toEqual([{ type: "text", text: "raw text answer" }]);
  });

  it("fails clearly when there is no recording for a case or call", async () => {
    const provider = new RecordedProvider(dir);
    await expect(provider.complete({ ...seeded, caseId: "nope" })).rejects.toThrow(/No recorded answer for case "nope"/);
    await expect(provider.complete({ ...seeded, call: 3 })).rejects.toThrow(/call 3/);
  });
});

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeAnthropicFetch(status: number, payload: unknown) {
  const calls: Captured[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "request-id": "req_test" } }),
    );
  };
  return { fetchFn, calls };
}

const message = (over: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: '{"recommendation": ' },
    { type: "text", text: '"go"}' },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4321, output_tokens: 765, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
});

describe("Anthropic provider", () => {
  it("sends EXACTLY model, max_tokens, system, tools and messages (no fallback, no betas, no sampling) and returns the content", async () => {
    const { fetchFn, calls } = fakeAnthropicFetch(200, message());
    const provider = createAnthropicProvider({ apiKey: SECRET, model: "claude-sonnet-5-5", effort: null, fetch: fetchFn });
    const reply = await provider.complete(request());
    expect(reply.inputTokens).toBe(4321);
    expect(reply.outputTokens).toBe(765);
    // The whole content comes back, thinking included: it must be replayed unchanged on the next call.
    expect(reply.content.map((b) => b.type)).toEqual(["thinking", "text", "text"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    // No refusal fallback (it would answer with ANOTHER model) and nothing else we didn't choose.
    expect(calls[0]?.body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 1234,
      system: "System text.",
      tools: TOOLS,
      messages: [{ role: "user", content: "The prompt." }],
    });
    expect(calls[0]?.headers.get("anthropic-beta")).toBeNull();
    // The key travels only in the SDK's auth header (SDK 1.x: "Authorization: Bearer <key>").
    const auth = calls[0]?.headers.get("x-api-key") ?? calls[0]?.headers.get("authorization");
    expect(auth).toMatch(new RegExp(`${SECRET}$`));
    expect(JSON.stringify(calls[0]?.body)).not.toContain(SECRET);
  });

  it("adds output_config.effort only when --effort is given", async () => {
    const { fetchFn, calls } = fakeAnthropicFetch(200, message());
    await createAnthropicProvider({ apiKey: SECRET, model: "m", effort: "low", fetch: fetchFn }).complete(request());
    expect(calls[0]?.body.output_config).toEqual({ effort: "low" });
  });

  it("ignores ANTHROPIC_BASE_URL: the key only ever goes to https://api.anthropic.com", async () => {
    const before = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://attacker.example";
    try {
      const { fetchFn, calls } = fakeAnthropicFetch(200, message());
      await createAnthropicProvider({ apiKey: SECRET, model: "m", effort: null, fetch: fetchFn }).complete(request());
      expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = before;
    }
  });

  it("does not retry inside the SDK (maxRetries 0): a 500 is one request, and fails only this case", async () => {
    const { fetchFn, calls } = fakeAnthropicFetch(500, { type: "error", error: { type: "api_error", message: "boom" } });
    const error = await createAnthropicProvider({ apiKey: SECRET, model: "m", effort: null, fetch: fetchFn })
      .complete(request())
      .catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ fatal: false });
  });

  it("turns a refusal or a cut-off answer into a case error, not a crash, keeping the billed tokens", async () => {
    const refused = fakeAnthropicFetch(200, message({ stop_reason: "refusal", content: [] }));
    const p1 = createAnthropicProvider({ apiKey: SECRET, model: "m", effort: null, fetch: refused.fetchFn });
    const e1 = await p1.complete(request()).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1).toMatchObject({ fatal: false });
    expect((e1 as Error).message).toMatch(/refus/i);

    const cut = fakeAnthropicFetch(200, message({ stop_reason: "max_tokens" }));
    const p2 = createAnthropicProvider({ apiKey: SECRET, model: "m", effort: null, fetch: cut.fetchFn });
    const e2 = await p2.complete(request()).catch((e: unknown) => e);
    expect(e2).toMatchObject({ fatal: false, usage: { inputTokens: 4321, outputTokens: 765 } });
    expect((e2 as Error).message).toMatch(/max_tokens/);
  });

  it("stops the whole run on a bad key, and the error never contains the key", async () => {
    const { fetchFn } = fakeAnthropicFetch(401, {
      type: "error",
      error: { type: "authentication_error", message: `invalid x-api-key ${SECRET}` },
    });
    const provider = createAnthropicProvider({ apiKey: SECRET, model: "m", effort: null, fetch: fetchFn });
    const error = await provider.complete(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).fatal).toBe(true);
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });
});
