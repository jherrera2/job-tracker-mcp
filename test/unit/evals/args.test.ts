// Command-line options for `npm run evals` (evals/src/args.ts), including the hard caps.
import { describe, expect, it } from "vitest";
import { DEFAULTS, LIMITS, parseArgs } from "../../../evals/src/args.js";

const okOptions = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.options;
};
const errorOf = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error("expected an error");
  return parsed.message;
};

describe("parseArgs", () => {
  it("defaults: a plan only (no --yes), the default model, no case filter", () => {
    expect(okOptions([])).toEqual({
      dryRun: false,
      yes: false,
      model: DEFAULTS.model,
      maxOutputTokens: DEFAULTS.maxOutputTokens,
      maxUsd: DEFAULTS.maxUsd,
      effort: null,
      caseIds: null,
      outDir: DEFAULTS.outDir,
      repeats: 1,
    });
  });

  it("reads every flag, in both --flag value and --flag=value forms", () => {
    expect(
      okOptions([
        "--yes",
        "--model=claude-opus-5-5",
        "--max-output-tokens",
        "4000",
        "--max-usd=2.5",
        "--effort",
        "low",
        "--cases",
        "a,b",
        "--out",
        "/tmp/x",
        "--repeats",
        "3",
      ]),
    ).toMatchObject({
      yes: true,
      model: "claude-opus-5-5",
      maxOutputTokens: 4000,
      maxUsd: 2.5,
      effort: "low",
      caseIds: ["a", "b"],
      outDir: "/tmp/x",
      repeats: 3,
    });
    expect(okOptions(["--dry-run"]).dryRun).toBe(true);
  });

  it("refuses unknown flags, missing values and bad numbers", () => {
    expect(errorOf(["--yess"])).toMatch(/Unknown option "--yess"/);
    expect(errorOf(["--model"])).toMatch(/--model needs a value/);
    expect(errorOf(["--max-usd", "lots"])).toMatch(/--max-usd/);
    expect(errorOf(["--effort", "huge"])).toMatch(/--effort/);
  });

  it("pins the hard caps as literal numbers, so a change to them shows up in review", () => {
    expect(LIMITS).toEqual({
      maxCases: 40,
      maxOutputTokens: 16_000,
      maxUsd: 25,
      maxAttempts: 2,
      maxRepeats: 5,
      maxToolCallsPerReply: 3,
      maxToolResultChars: 2_000,
    });
    expect(DEFAULTS).toMatchObject({ model: "claude-sonnet-5-5", maxOutputTokens: 8_000, maxUsd: 5 });
  });

  it("--repeats is a whole number from 1 to 5", () => {
    expect(errorOf(["--repeats", "0"])).toMatch(/--repeats/);
    expect(errorOf(["--repeats", "6"])).toMatch(/--repeats/);
    expect(errorOf(["--repeats", "1.5"])).toMatch(/--repeats/);
  });

  it(`enforces the hard caps: output tokens ≤ ${LIMITS.maxOutputTokens}, spend ≤ $${LIMITS.maxUsd}`, () => {
    expect(errorOf(["--max-output-tokens", String(LIMITS.maxOutputTokens + 1)])).toMatch(/--max-output-tokens/);
    expect(errorOf(["--max-output-tokens", "0"])).toMatch(/--max-output-tokens/);
    expect(errorOf(["--max-usd", String(LIMITS.maxUsd + 1)])).toMatch(/--max-usd/);
    expect(errorOf(["--max-usd", "0"])).toMatch(/--max-usd/);
  });
});
