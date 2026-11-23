// One case's conversation (evals/src/runner.ts), driven with a stand-in harness and provider, so
// the exact messages the model sees are pinned here. The real tools behind it are covered by
// test/integration/evals-dry-run.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../../../evals/src/dataset.js";
import type { Harness, ToolResult } from "../../../evals/src/harness.js";
import { ProviderError, type ModelProvider, type ModelReply, type ModelRequest } from "../../../evals/src/provider.js";
import { LIMITS } from "../../../evals/src/args.js";
import { HARNESS_SYSTEM_PROMPT, runCase } from "../../../evals/src/runner.js";

const { maxToolCallsPerReply: MAX_TOOL_CALLS_PER_REPLY, maxToolResultChars: MAX_TOOL_RESULT_CHARS } = LIMITS;

const evalCase: EvalCase = {
  id: "c1",
  title: "Case one",
  kind: "fit",
  expected: ["go"],
  twinOf: null,
  flagPhrases: [],
  posting: { source: "paste", title: "T", company: "C (fictional)", text: "x" },
};

const INPUTS = { job_id: 7, ref: "fit1-j7-p1-m1-c0123456789abcdef", prompt: "THE FULL PROMPT" };
const INPUTS_TEXT = JSON.stringify(INPUTS);
const TOOLS = [{ name: "save_fit", description: "d", input_schema: { type: "object" as const } }];
const SAVED_FIT = {
  jd_match_pct: 50,
  criteria_match_pct: 40,
  recommendation: "go",
  weak_go: false,
  quotes_dropped: 0,
  requirements: [{ text: "TS", status: "met", evidence_quote: "q" }],
  criteria: [
    { label: "Pay floor", status: "met", reason: "Above the floor." },
    { label: "Light on-call", status: "unclear", reason: "Not said." },
  ],
  red_flags: [],
};

function fakeHarness(saveFit: (args: Record<string, unknown>) => Promise<ToolResult>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const call = vi.fn((name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    calls.push({ name, args });
    if (name === "get_fit_inputs") return Promise.resolve({ content: [{ type: "text", text: INPUTS_TEXT }], structuredContent: INPUTS });
    if (name === "save_fit") return saveFit(args);
    if (name === "get_job") return Promise.resolve({ content: [], structuredContent: { latest_fit: SAVED_FIT } });
    return Promise.reject(new Error(`unexpected tool ${name}`));
  });
  const harness: Harness = {
    schema: "eval_x",
    tools: TOOLS,
    call,
    callOk: async (name, args) => (await call(name, args)).structuredContent ?? {},
    addJob: () => Promise.resolve(7),
    close: () => Promise.resolve(),
  };
  return { harness, calls };
}

const saveOk = () => Promise.resolve<ToolResult>({ content: [{ type: "text", text: "{}" }], structuredContent: {} });
const saveError = (text: string) => () => Promise.resolve<ToolResult>({ content: [{ type: "text", text }], isError: true });

function scriptedProvider(replies: (ModelReply | Error)[]) {
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    name: "anthropic",
    model: "m",
    complete: (req) => {
      // Copy the messages: the runner keeps appending to the same array.
      requests.push(structuredClone(req));
      const next = replies[requests.length - 1];
      if (!next) return Promise.reject(new Error("no more replies"));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { provider, requests };
}

/** A reply calling save_fit for the case's own job (7) unless the input says otherwise. */
const saveCall = (id: string, input: Record<string, unknown>): ModelReply => ({
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "tool_use", id, name: "save_fit", input: { job_id: 7, ...input } },
  ],
  inputTokens: 1000,
  outputTokens: 200,
});

let tick = 0;
const OPTIONS = { maxOutputTokens: 500, maxCalls: 2, clock: () => (tick += 100) };

describe("runCase", () => {
  it("shows the model get_fit_inputs' result as a tool_result, offers the real tools, and forwards its save_fit call", async () => {
    const { harness, calls } = fakeHarness(saveOk);
    const answer = { job_id: 7, ref: INPUTS.ref, result: { recommendation: "go" } };
    const { provider, requests } = scriptedProvider([saveCall("toolu_a", answer)]);
    const run = await runCase(harness, evalCase, 0, provider, OPTIONS);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ caseId: "c1", call: 1, system: HARNESS_SYSTEM_PROMPT, tools: TOOLS, maxOutputTokens: 500 });
    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "Run a fit check on job 7 against my master résumé and criteria, and save it." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_harness_get_fit_inputs", name: "get_fit_inputs", input: { job_id: 7 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_harness_get_fit_inputs", content: INPUTS_TEXT }] },
    ]);
    // The model's own arguments go to save_fit unchanged (job_id, ref and result are its work).
    expect(calls.find((c) => c.name === "save_fit")?.args).toEqual(answer);
    expect(run).toMatchObject({ caseId: "c1", jobId: 7, error: null, fatal: false, saved: { jdPct: 50, recommendation: "go" } });
    expect(run.attempts).toEqual([{ latencyMs: 100, inputTokens: 1000, outputTokens: 200, saveError: null, reply: [{ type: "tool_use", id: "toolu_a", name: "save_fit", input: answer }] }]);
    // get_fit_inputs ran once: the harness's own call.
    expect(calls.filter((c) => c.name === "get_fit_inputs")).toHaveLength(1);
  });

  it("reads each criterion's label, status and reason back from get_job (step 12: the reason shows WHY an attack moved it)", async () => {
    const { harness } = fakeHarness(saveOk);
    const { provider } = scriptedProvider([saveCall("toolu_a", { ref: INPUTS.ref, result: {} })]);
    const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
    expect(run.saved?.criteria).toEqual([
      { label: "Pay floor", status: "met", reason: "Above the floor." },
      { label: "Light on-call", status: "unclear", reason: "Not said." },
    ]);
  });

  it("on a save_fit error, replays the full reply (thinking included) and returns the error as an is_error tool_result", async () => {
    const { harness } = fakeHarness(vi.fn().mockImplementationOnce(saveError("Requirement 1: status must be …")).mockImplementation(saveOk));
    const { provider, requests } = scriptedProvider([saveCall("toolu_a", { n: 1 }), saveCall("toolu_b", { n: 2 })]);
    const run = await runCase(harness, evalCase, 0, provider, OPTIONS);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.call).toBe(2);
    expect(requests[1]?.messages.slice(3)).toEqual([
      { role: "assistant", content: saveCall("toolu_a", { n: 1 }).content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "Requirement 1: status must be …", is_error: true }] },
    ]);
    expect(run.saved).not.toBeNull();
    expect(run.attempts.map((a) => a.saveError)).toEqual(["Requirement 1: status must be …", null]);
  });

  it("makes at most 2 model calls per case", async () => {
    const { harness } = fakeHarness(saveError("bad"));
    const { provider, requests } = scriptedProvider([saveCall("a", {}), saveCall("b", {}), saveCall("c", {})]);
    const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
    expect(requests).toHaveLength(2);
    expect(run).toMatchObject({ saved: null, fatal: false });
    expect(run.error).toMatch(/No fit check was saved after 2 model calls.*bad/);
  });

  it("fails the case when the model answers without calling save_fit", async () => {
    const { harness } = fakeHarness(saveOk);
    const { provider, requests } = scriptedProvider([{ content: [{ type: "text", text: "{}" }], inputTokens: 10, outputTokens: 5 }]);
    const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
    expect(requests).toHaveLength(1);
    expect(run.error).toMatch(/without calling save_fit/);
    expect(run.attempts).toHaveLength(1);
  });

  it("answers a call to a tool it doesn't offer with an is_error tool_result", async () => {
    const { harness, calls } = fakeHarness(saveOk);
    const { provider, requests } = scriptedProvider([
      { content: [{ type: "tool_use", id: "x", name: "delete_everything", input: {} }], inputTokens: 1, outputTokens: 1 },
      saveCall("y", {}),
    ]);
    await runCase(harness, evalCase, 0, provider, OPTIONS);
    expect(calls.map((c) => c.name)).not.toContain("delete_everything");
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "x", content: 'There is no tool named "delete_everything" here.', is_error: true }],
    });
  });

  it("keeps the attempts (and their tokens) when something fails AFTER the model answered", async () => {
    const { harness } = fakeHarness(() => Promise.reject(new Error("connection lost")));
    const { provider } = scriptedProvider([saveCall("a", {})]);
    const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
    expect(run).toMatchObject({ saved: null, fatal: false, error: "connection lost" });
    expect(run.attempts).toHaveLength(1);
    expect(run.attempts[0]).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
  });

  it("marks the run fatal on a fatal provider error, and keeps billed tokens of a non-fatal one", async () => {
    const fatal = await runCase(fakeHarness(saveOk).harness, evalCase, 0, scriptedProvider([new ProviderError("bad key", true)]).provider, OPTIONS);
    expect(fatal).toMatchObject({ fatal: true, error: "bad key", saved: null });

    const cut = new ProviderError("cut off", false, { inputTokens: 900, outputTokens: 500 });
    const soft = await runCase(fakeHarness(saveOk).harness, evalCase, 0, scriptedProvider([cut]).provider, OPTIONS);
    expect(soft).toMatchObject({ fatal: false, error: "cut off" });
    expect(soft.attempts[0]).toMatchObject({ inputTokens: 900, outputTokens: 500 });
  });

  describe("tool-call limits (a true cost bound)", () => {
    const toolUse = (id: string, name: string, input: Record<string, unknown> = { job_id: 7 }) =>
      ({ type: "tool_use", id, name, input }) as const;
    const reply = (blocks: ModelReply["content"]): ModelReply => ({ content: blocks, inputTokens: 1, outputTokens: 1 });
    const chars = (req: ModelRequest | undefined) => JSON.stringify(req?.messages ?? []).length;

    it(`a reply with more than ${MAX_TOOL_CALLS_PER_REPLY} tool calls ends the case: nothing runs, no second call`, async () => {
      const { harness, calls } = fakeHarness(saveOk);
      const fifty = Array.from({ length: 50 }, (_, i) => toolUse(`g${i}`, "get_fit_inputs"));
      const { provider, requests } = scriptedProvider([reply(fifty), saveCall("s", {})]);
      const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
      expect(requests).toHaveLength(1);
      expect(calls.map((c) => c.name)).toEqual(["get_fit_inputs"]); // only the harness's own call
      expect(run).toMatchObject({ saved: null, fatal: false });
      expect(run.error).toMatch(/50 tool calls in one reply; at most 3/);
    });

    it("never runs get_fit_inputs again: the model's calls get a short is_error, and the next request stays small", async () => {
      const { harness, calls } = fakeHarness(saveOk);
      const { provider, requests } = scriptedProvider([
        reply([toolUse("g1", "get_fit_inputs"), toolUse("g2", "get_fit_inputs"), toolUse("g3", "get_fit_inputs")]),
        saveCall("s", {}),
      ]);
      const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
      expect(calls.filter((c) => c.name === "get_fit_inputs")).toHaveLength(1);
      const results = requests[1]?.messages.at(-1)?.content;
      expect(results).toEqual(
        ["g1", "g2", "g3"].map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          content: "get_fit_inputs already ran for this fit check; its result is above.",
          is_error: true,
        })),
      );
      // The second request is the first plus the reply plus at most the tool-result cap.
      expect(chars(requests[1]) - chars(requests[0])).toBeLessThanOrEqual(
        JSON.stringify(requests[1]?.messages.at(-2)).length + MAX_TOOL_CALLS_PER_REPLY * (MAX_TOOL_RESULT_CHARS + 200),
      );
      expect(run.saved).not.toBeNull();
    });

    it("stops after the first successful save_fit: a second save_fit in the same reply is not run", async () => {
      const { harness, calls } = fakeHarness(saveOk);
      const { provider, requests } = scriptedProvider([
        { content: [...saveCall("s1", {}).content, ...saveCall("s2", {}).content.slice(1)], inputTokens: 1, outputTokens: 1 },
      ]);
      const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
      expect(calls.filter((c) => c.name === "save_fit")).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(run.saved).not.toBeNull();
    });

    it(`cuts each tool result to ${MAX_TOOL_RESULT_CHARS} characters`, async () => {
      const { harness } = fakeHarness(saveError("x".repeat(10_000)));
      const { provider, requests } = scriptedProvider([saveCall("a", {}), saveCall("b", {})]);
      await runCase(harness, evalCase, 0, provider, OPTIONS);
      const last = requests[1]?.messages.at(-1)?.content;
      const block = Array.isArray(last) ? last[0] : undefined;
      if (block?.type !== "tool_result" || typeof block.content !== "string") throw new Error("expected a tool_result");
      expect(block.content.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
      expect(block.content.endsWith("… [cut]")).toBe(true);
    });

    it("refuses a save_fit for another job without running it", async () => {
      const { harness, calls } = fakeHarness(saveOk);
      const { provider, requests } = scriptedProvider([saveCall("a", { job_id: 99 }), saveCall("b", {})]);
      const run = await runCase(harness, evalCase, 0, provider, OPTIONS);
      expect(calls.filter((c) => c.name === "save_fit").map((c) => c.args.job_id)).toEqual([7]);
      expect(requests[1]?.messages.at(-1)).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "This fit check is for job 7; save_fit was not run for job 99.", is_error: true }],
      });
      expect(run.saved).not.toBeNull();
    });
  });

  it("hands get_fit_inputs' result over WHOLE, however long (only results of the model's own calls are cut)", async () => {
    const longText = JSON.stringify({ ...INPUTS, prompt: "p".repeat(20_000) });
    const { harness } = fakeHarness(saveOk);
    const call = harness.call.bind(harness);
    harness.call = (name, args) =>
      name === "get_fit_inputs" ? Promise.resolve({ content: [{ type: "text", text: longText }] }) : call(name, args);
    const { provider, requests } = scriptedProvider([saveCall("a", {})]);
    await runCase(harness, evalCase, 0, provider, OPTIONS);
    expect(requests[0]?.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_harness_get_fit_inputs", content: longText }] });
  });

  it("makes no further model call once the run is interrupted", async () => {
    const { harness } = fakeHarness(saveError("bad"));
    let stop = false;
    const { provider, requests } = scriptedProvider([saveCall("a", {}), saveCall("b", {})]);
    const wrapped: ModelProvider = { ...provider, complete: (req) => ((stop = true), provider.complete(req)) };
    const run = await runCase(harness, evalCase, 0, wrapped, { ...OPTIONS, stopped: () => stop });
    expect(requests).toHaveLength(1);
    expect(run.error).toBe("Interrupted.");
  });
});
