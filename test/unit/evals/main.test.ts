// The cost guard and secret handling of `npm run evals` (evals/src/main.ts). No database and no
// network here: every path below stops before the database is opened or a model is called.
import { describe, expect, it, vi } from "vitest";
import { resolveCases, type CaseDef } from "../../../evals/src/dataset.js";
import { CASES } from "../../../evals/dataset/cases.js";
import { readMasterResume } from "../../../evals/src/dataset.js";
import { listModelTools } from "../../../evals/src/harness.js";
import { promptFor, runEvals, selectCases, sizeFirstRequests, type EvalDeps } from "../../../evals/src/main.js";
import type { ModelProvider } from "../../../evals/src/provider.js";

const SECRET = "sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-0123456789";

function harness(env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const complete = vi.fn(() => Promise.reject(new Error("must not be called")));
  const provider: ModelProvider = { name: "anthropic", model: "claude-sonnet-5-5", complete };
  const createProvider = vi.fn(() => provider);
  const deps: EvalDeps = {
    // No database URL on purpose: reaching the database would fail these tests loudly.
    env: { ANTHROPIC_API_KEY: SECRET, ...env },
    out: (text) => lines.push(text),
    err: (text) => lines.push(text),
    createProvider,
  };
  return { deps, lines, createProvider, complete, output: () => lines.join("\n") };
}

describe("cost guard", () => {
  it("without --yes: prints the case count, model and estimated max cost, then stops without calling anything", async () => {
    const h = harness();
    const code = await runEvals([], h.deps);
    expect(code).toBe(0);
    expect(h.output()).toMatch(/Cases: 24/);
    expect(h.output()).toMatch(/Model: claude-sonnet-5-5/);
    expect(h.output()).toMatch(/Estimated max cost: \$\d+\.\d{2}/);
    expect(h.output()).toMatch(/--yes/);
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("refuses, even with --yes, when the worst case is above --max-usd", async () => {
    const h = harness();
    const code = await runEvals(["--yes", "--max-usd", "0.01"], h.deps);
    expect(code).toBe(2);
    expect(h.output()).toMatch(/above --max-usd/);
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("refuses a model with no price in the table rather than guessing its cost", async () => {
    const h = harness();
    expect(await runEvals(["--yes", "--model", "claude-mystery-9"], h.deps)).toBe(2);
    expect(h.output()).toMatch(/no price/i);
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("refuses --yes without ANTHROPIC_API_KEY, naming the variable and nothing else", async () => {
    const h = harness({ ANTHROPIC_API_KEY: "  " });
    expect(await runEvals(["--yes"], h.deps)).toBe(2);
    expect(h.output()).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("refuses --dry-run together with --yes (a dry run never calls the API), even with a database set", async () => {
    const h = harness({ TEST_DATABASE_URL: "postgres://u:p@localhost:5432/jobsearch_test" });
    expect(await runEvals(["--dry-run", "--yes"], h.deps)).toBe(2);
    expect(h.output()).toMatch(/--dry-run never calls the API; leave out --yes\./);
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("refuses unknown case ids", async () => {
    const h = harness();
    expect(await runEvals(["--cases", "nope"], h.deps)).toBe(2);
    expect(h.output()).toMatch(/Unknown case "nope"/);
  });

  it("adds an attack's clean twin when --cases names the attack without it, and says so", async () => {
    const h = harness();
    expect(await runEvals(["--cases", "inj-fake-system"], h.deps)).toBe(0);
    expect(h.output()).toMatch(/Cases: 2\b/);
    expect(h.output()).toMatch(/Added java-onsite, the clean twin of inj-fake-system/);
  });

  it("--repeats multiplies the runs and the estimated cost", async () => {
    const once = harness();
    await runEvals(["--cases", "ts-backend-health,java-onsite"], once.deps);
    const twice = harness();
    await runEvals(["--cases", "ts-backend-health,java-onsite", "--repeats", "2"], twice.deps);
    const dollars = (text: string) => Number(/Estimated max cost: \$(\d+\.\d+)/.exec(text)?.[1]);
    expect(twice.output()).toMatch(/Cases: 2 × 2 runs = 4/);
    expect(dollars(twice.output())).toBeCloseTo(2 * dollars(once.output()), 1);
  });

  it("refuses more than 40 case runs per run (cases × repeats)", async () => {
    const h = harness();
    expect(await runEvals(["--repeats", "3"], h.deps)).toBe(2);
    expect(h.output()).toMatch(/At most 40 case runs per run \(24 cases × 3 = 72\)/);
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("can plan a subset of cases", async () => {
    const h = harness();
    expect(await runEvals(["--cases", "ios-swift,java-onsite"], h.deps)).toBe(0);
    expect(h.output()).toMatch(/Cases: 2/);
  });
});

describe("the API key", () => {
  it("is never printed, even when an error message contains it", async () => {
    const h = harness({ TEST_DATABASE_URL: undefined });
    h.createProvider.mockImplementation(() => {
      throw new Error(`401 invalid x-api-key ${SECRET}`);
    });
    const code = await runEvals(["--yes"], h.deps);
    expect(code).toBe(1);
    expect(h.createProvider).toHaveBeenCalledOnce();
    expect(h.output()).toContain("[redacted]");
    expect(h.output()).not.toContain(SECRET);
    expect(h.output()).not.toContain("THIS-IS-A-FAKE");
  });

  it("is not in the plan output", async () => {
    const h = harness();
    await runEvals([], h.deps);
    expect(h.output()).not.toContain(SECRET);
  });
});

describe("selectCases", () => {
  const fit = (id: string): CaseDef => ({
    id,
    title: id,
    kind: "fit",
    expected: ["go"],
    posting: { source: "paste", title: "T", company: "C (fictional)", text: "x" },
  });

  it("caps a run at 40 case runs: 40 cases pass, 41 are refused", () => {
    const forty = resolveCases(Array.from({ length: 40 }, (_, i) => fit(`c${i}`)));
    expect(selectCases(forty, null, 1)).toMatchObject({ ok: true });
    const fortyOne = resolveCases(Array.from({ length: 41 }, (_, i) => fit(`c${i}`)));
    expect(selectCases(fortyOne, null, 1)).toMatchObject({ ok: false });
    expect(selectCases(forty, null, 2)).toMatchObject({ ok: false });
  });

  it("keeps the dataset's order and adds missing twins", () => {
    const all = resolveCases([
      fit("a"),
      fit("b"),
      { id: "i", title: "i", kind: "injection", twinOf: "a", flagPhrases: ["x"], injection: { text: "ATTACK" } },
    ]);
    const picked = selectCases(all, ["i"], 1);
    expect(picked).toMatchObject({ ok: true, added: ["a"] });
    if (picked.ok) expect(picked.cases.map((c) => c.id)).toEqual(["a", "i"]);
  });
});

describe("sizeFirstRequests (what the cost estimate is built from)", () => {
  it("counts the tool definitions AND the real fit prompt for every case", async () => {
    const cases = resolveCases(CASES);
    const resume = readMasterResume();
    const toolsChars = JSON.stringify(await listModelTools()).length;
    const sizes = await sizeFirstRequests(cases, resume);
    expect(sizes.size).toBe(cases.length);
    for (const c of cases) {
      const prompt = promptFor(c, resume);
      expect(prompt).toContain(resume.trim());
      expect(sizes.get(c.id)).toBeGreaterThan(toolsChars + prompt.length);
    }
  });
});
