// The fit-check answer the user's chat model sends to save_fit (PRD 01 §5): its shape, its limits,
// and the criteria labels it must use. Pure functions, no database.
//
// Every rejection is ONE short sentence the chat model can act on (it resubmits), naming the item
// and the field ("Requirement 2: …"), never Zod's own wording.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_MAKE_EXPLICIT_CHARS,
  MAX_REASON_CHARS,
  MAX_RED_FLAG_CHARS,
  MAX_RED_FLAGS,
  MAX_REQUIREMENT_TEXT_CHARS,
  MAX_REQUIREMENTS,
  MAX_RESULT_JSON_CHARS,
  MAX_SUMMARY_CHARS,
  matchCriteriaLabels,
  parseFitResult,
  type FitResult,
} from "../../src/domain/fit-result.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/fit/${name}`, import.meta.url), "utf8"));

const valid = (): Record<string, unknown> => fixture("answer-valid.json") as Record<string, unknown>;

function parseError(input: unknown): string {
  const parsed = parseFitResult(input);
  if (parsed.ok) throw new Error("expected a rejection");
  return parsed.message;
}

function parseOk(input: unknown): FitResult {
  const parsed = parseFitResult(input);
  if (!parsed.ok) throw new Error(`expected success, got: ${parsed.message}`);
  return parsed.result;
}

describe("parseFitResult — accepted answers", () => {
  it("accepts the recorded valid answer and keeps every field", () => {
    const result = parseOk(valid());
    expect(result).toEqual(valid());
  });

  it("accepts the answer as a JSON string too (some chat apps send it that way)", () => {
    expect(parseOk(JSON.stringify(valid()))).toEqual(valid());
  });

  it("trims blank space at the ends of text fields", () => {
    const answer = valid();
    answer.summary = "  One sentence.  \n";
    answer.red_flags = ["  Vague pay  "];
    expect(parseOk(answer)).toMatchObject({ summary: "One sentence.", red_flags: ["Vague pay"] });
  });

  it("ignores any score the model sends: unknown fields are dropped, at every level", () => {
    const result = parseOk(fixture("answer-injected.json"));
    expect(result).not.toHaveProperty("jd_match_pct");
    expect(result).not.toHaveProperty("criteria_match_pct");
    expect(result).not.toHaveProperty("score");

    const answer = valid();
    (answer.requirements as Record<string, unknown>[])[0]!.weight = 10;
    expect(parseOk(answer).requirements[0]).not.toHaveProperty("weight");
  });

  it("drops an evidence_quote on a missing requirement (missing has no evidence)", () => {
    const answer = valid();
    (answer.requirements as Record<string, unknown>[])[3]!.evidence_quote = "Something";
    expect(parseOk(answer).requirements[3]).toEqual({ text: "Experience with Kubernetes", status: "missing" });
  });

  it("treats evidence_quote: null like no quote (models often send null)", () => {
    const answer = valid();
    (answer.requirements as Record<string, unknown>[])[3]!.evidence_quote = null;
    expect(parseOk(answer).requirements[3]).toEqual({ text: "Experience with Kubernetes", status: "missing" });

    const met = valid();
    (met.requirements as Record<string, unknown>[])[0]!.evidence_quote = null;
    expect(parseError(met)).toMatch(/^Requirement 1 is "met", so it needs an evidence_quote/);
  });

  it("treats an empty evidence_quote on a missing requirement as no quote", () => {
    const answer = valid();
    (answer.requirements as Record<string, unknown>[])[3]!.evidence_quote = "";
    expect(parseOk(answer).requirements[3]).toEqual({ text: "Experience with Kubernetes", status: "missing" });
  });

  it("accepts empty criteria and red_flags lists", () => {
    const answer = { ...valid(), criteria: [], red_flags: [] };
    expect(parseOk(answer)).toMatchObject({ criteria: [], red_flags: [] });
  });
});

describe("parseFitResult — rejected answers", () => {
  it("rejects the recorded invalid answer with a sentence naming the first bad field", () => {
    expect(parseError(fixture("answer-invalid-shape.json"))).toBe(
      'Requirement 1: status must be "met", "partial" or "missing".',
    );
  });

  it("rejects a recommendation other than go / maybe / skip", () => {
    expect(parseError({ ...valid(), recommendation: "apply" })).toBe('recommendation must be "go", "maybe" or "skip".');
  });

  it("rejects a criterion status other than met / unclear / not_met (the PRD's 'not met' is spelled not_met)", () => {
    const answer = valid();
    (answer.criteria as Record<string, unknown>[])[1]!.status = "not met";
    expect(parseError(answer)).toBe('Criterion 2: status must be "met", "unclear" or "not_met".');
  });

  it("rejects a met or partial requirement without an evidence quote", () => {
    const answer = valid();
    delete (answer.requirements as Record<string, unknown>[])[1]!.evidence_quote;
    expect(parseError(answer)).toBe(
      'Requirement 2 is "met", so it needs an evidence_quote copied word for word from the master résumé. If there is none, mark it "missing".',
    );

    const invisible = valid();
    (invisible.requirements as Record<string, unknown>[])[0]!.evidence_quote = "\u200B\u00AD";
    expect(parseError(invisible)).toMatch(/^Requirement 1 is "met", so it needs an evidence_quote/);

    const blank = valid();
    (blank.requirements as Record<string, unknown>[])[2]!.evidence_quote = "   ";
    expect(parseError(blank)).toMatch(/^Requirement 3 is "partial", so it needs an evidence_quote/);
  });

  it.each([
    ["requirements", "requirements is missing. Send it as a list of the posting's requirements."],
    ["criteria", "criteria is missing. Send it as a list (empty when no criteria are saved)."],
    ["red_flags", "red_flags is missing. Send it as a list (empty when there are none)."],
    ["recommendation", 'recommendation is missing. Send "go", "maybe" or "skip".'],
    ["summary", "summary is missing. Send one sentence."],
  ])("names a missing top-level field: %s", (field, message) => {
    const answer = valid();
    delete answer[field];
    expect(parseError(answer)).toBe(message);
  });

  it("rejects an empty requirements list", () => {
    expect(parseError({ ...valid(), requirements: [] })).toBe(
      "requirements is empty. List the requirements the posting states (at least one).",
    );
  });

  it("rejects a list sent where a list is expected but something else arrived", () => {
    expect(parseError({ ...valid(), red_flags: "none" })).toBe("red_flags must be a list.");
    expect(parseError({ ...valid(), requirements: { text: "x" } })).toBe("requirements must be a list.");
  });

  it("rejects a requirement with blank text", () => {
    const answer = valid();
    (answer.requirements as Record<string, unknown>[])[0]!.text = "  ";
    expect(parseError(answer)).toBe("Requirement 1: text is empty. Write the requirement in the posting's terms.");
  });

  it("rejects a criterion without a reason", () => {
    const answer = valid();
    delete (answer.criteria as Record<string, unknown>[])[0]!.reason;
    expect(parseError(answer)).toBe("Criterion 1: reason is missing. Give one sentence.");
  });

  it("rejects a red flag that is not text", () => {
    expect(parseError({ ...valid(), red_flags: ["ok", 5] })).toBe("Red flag 2 must be text.");
  });

  it("rejects an evidence quote holding control characters", () => {
    const answer = valid();
    (answer.requirements as Record<string, unknown>[])[0]!.evidence_quote = "TypeScript\u0000";
    expect(parseError(answer)).toBe(
      "Requirement 1: evidence_quote has characters that aren't text (control characters). Copy it from the résumé as plain text.",
    );
  });

  it("rejects text holding control characters (a file's raw bytes)", () => {
    expect(parseError({ ...valid(), summary: "Bad\u0000summary" })).toBe(
      "summary has characters that aren't text (control characters). Write it as plain text.",
    );
  });

  it("rejects something that is not a JSON object", () => {
    const message =
      "The result must be a JSON object with requirements, criteria, red_flags, recommendation and summary.";
    expect(parseError(42)).toBe(message);
    expect(parseError([valid()])).toBe(message);
    expect(parseError(null)).toBe(message);
    expect(parseError("[1, 2]")).toBe(message);
  });

  it("rejects a string that is not valid JSON", () => {
    expect(parseError("{ requirements: oops")).toBe(
      "The result is not valid JSON. Send the JSON object itself, with no text before or after it.",
    );
  });

  describe("size limits", () => {
    it(`allows at most ${MAX_REQUIREMENTS} requirements`, () => {
      const one = { text: "Kubernetes", status: "missing" };
      expect(parseOk({ ...valid(), requirements: Array(MAX_REQUIREMENTS).fill(one) }).requirements).toHaveLength(
        MAX_REQUIREMENTS,
      );
      expect(parseError({ ...valid(), requirements: Array(MAX_REQUIREMENTS + 1).fill(one) })).toBe(
        `There are ${MAX_REQUIREMENTS + 1} requirements; the limit is ${MAX_REQUIREMENTS}. Merge small ones and keep the ones that matter.`,
      );
    });

    it("refuses a huge list by its length, before reading its items", () => {
      const huge = Array(1_000_000).fill(5);
      const started = performance.now();
      expect(parseError({ ...valid(), red_flags: huge })).toBe(
        `There are 1,000,000 red flags; the limit is ${MAX_RED_FLAGS}. Keep the ones that matter.`,
      );
      expect(performance.now() - started).toBeLessThan(200);
    });

    it("allows at most 5 criteria results (the most a user can save)", () => {
      const c = { label: "Pay floor", status: "met", reason: "Yes." };
      expect(parseError({ ...valid(), criteria: Array(6).fill(c) })).toBe(
        "There are 6 criteria results; the limit is 5, one per saved criterion.",
      );
    });

    it("caps an evidence quote at 1,000 characters", () => {
      expect(MAX_EVIDENCE_QUOTE_CHARS).toBe(1000);
      const answer = valid();
      (answer.requirements as Record<string, unknown>[])[0]!.evidence_quote = "a".repeat(MAX_EVIDENCE_QUOTE_CHARS + 1);
      expect(parseError(answer)).toBe(
        `Requirement 1: evidence_quote is ${(MAX_EVIDENCE_QUOTE_CHARS + 1).toLocaleString("en-US")} characters; the limit is ${MAX_EVIDENCE_QUOTE_CHARS.toLocaleString("en-US")}. Quote a shorter passage.`,
      );
    });

    it(`caps the summary at ${MAX_SUMMARY_CHARS} characters, counted as a person counts them`, () => {
      expect(parseOk({ ...valid(), summary: "😀".repeat(MAX_SUMMARY_CHARS) }).summary).toHaveLength(MAX_SUMMARY_CHARS * 2);
      expect(parseError({ ...valid(), summary: "😀".repeat(MAX_SUMMARY_CHARS + 1) })).toBe(
        `summary is ${MAX_SUMMARY_CHARS + 1} characters; the limit is ${MAX_SUMMARY_CHARS}. Shorten it.`,
      );
    });

    it("refuses a JSON string longer than the whole answer could ever be", () => {
      const tooLong = JSON.stringify({ ...valid(), summary: "x".repeat(MAX_RESULT_JSON_CHARS) });
      expect(parseError(tooLong)).toBe(
        `The result is ${tooLong.length.toLocaleString("en-US")} characters of JSON; the limit is ${MAX_RESULT_JSON_CHARS.toLocaleString("en-US")}.`,
      );
    });
  });
});

// Step 11 (employer view): a "partial" requirement may carry a make_explicit suggestion, a short
// sentence naming a fact ALREADY in the master résumé that, written plainly, would make it "met".
// It must come with make_explicit_quote, copied word for word from the résumé (checked later by
// the quote check, src/domain/quote-check.ts). Both are optional; on met / missing they are dropped.
describe("parseFitResult — make_explicit suggestions (step 11)", () => {
  const SUGGESTION = "Say plainly that you mentored four junior engineers through their first production launches.";
  const QUOTE = "Mentored four junior engineers through their first production launches.";

  /** The valid answer with requirement 3 (partial, "Mentor other engineers") carrying `fields`. */
  function withSuggestion(fields: Record<string, unknown>, index = 2): Record<string, unknown> {
    const answer = valid();
    Object.assign((answer.requirements as Record<string, unknown>[])[index]!, fields);
    return answer;
  }

  it("keeps a suggestion and its quote on a partial requirement, trimmed", () => {
    const result = parseOk(withSuggestion({ make_explicit: `  ${SUGGESTION} `, make_explicit_quote: `\n${QUOTE}  ` }));
    expect(result.requirements[2]).toEqual({
      text: "Mentor other engineers",
      status: "partial",
      evidence_quote: "Mentored four junior engineers",
      make_explicit: SUGGESTION,
      make_explicit_quote: QUOTE,
    });
  });

  it("leaves the requirement unchanged when the suggestion is left out (the model found no grounding fact)", () => {
    expect(parseOk(valid()).requirements[2]).toEqual({
      text: "Mentor other engineers",
      status: "partial",
      evidence_quote: "Mentored four junior engineers",
    });
  });

  it("treats null or blank fields as not given", () => {
    for (const blank of [null, "", "   ", "\u200B"]) {
      const result = parseOk(withSuggestion({ make_explicit: blank, make_explicit_quote: blank }));
      expect(result.requirements[2]).not.toHaveProperty("make_explicit");
      expect(result.requirements[2]).not.toHaveProperty("make_explicit_quote");
    }
  });

  it("drops a suggestion on a met or missing requirement (only partial can become met)", () => {
    const met = parseOk(withSuggestion({ make_explicit: SUGGESTION, make_explicit_quote: QUOTE }, 0));
    expect(met.requirements[0]).not.toHaveProperty("make_explicit");
    expect(met.requirements[0]).not.toHaveProperty("make_explicit_quote");
    const missing = parseOk(withSuggestion({ make_explicit: SUGGESTION, make_explicit_quote: QUOTE }, 3));
    expect(missing.requirements[3]).toEqual({ text: "Experience with Kubernetes", status: "missing" });
  });

  it("refuses a suggestion without its quote: a suggestion must be grounded in the résumé", () => {
    expect(parseError(withSuggestion({ make_explicit: SUGGESTION }))).toBe(
      "Requirement 3 has a make_explicit suggestion, so it needs a make_explicit_quote copied word for word from the master résumé. If the résumé has no such fact, leave make_explicit out.",
    );
    expect(parseError(withSuggestion({ make_explicit: SUGGESTION, make_explicit_quote: "  " }))).toMatch(
      /^Requirement 3 has a make_explicit suggestion, so it needs a make_explicit_quote/,
    );
  });

  it("refuses a quote without a suggestion", () => {
    expect(parseError(withSuggestion({ make_explicit_quote: QUOTE }))).toBe(
      "Requirement 3 has a make_explicit_quote but no make_explicit. Send both, or leave both out.",
    );
  });

  it("refuses fields that are not text", () => {
    expect(parseError(withSuggestion({ make_explicit: 5, make_explicit_quote: QUOTE }))).toBe(
      "Requirement 3: make_explicit must be text.",
    );
    expect(parseError(withSuggestion({ make_explicit: SUGGESTION, make_explicit_quote: ["x"] }))).toBe(
      "Requirement 3: make_explicit_quote must be text.",
    );
  });

  it("refuses control characters", () => {
    expect(parseError(withSuggestion({ make_explicit: "Say\u0000it", make_explicit_quote: QUOTE }))).toBe(
      "Requirement 3: make_explicit has characters that aren't text (control characters). Write it as plain text.",
    );
    expect(parseError(withSuggestion({ make_explicit: SUGGESTION, make_explicit_quote: "Mentored\u0007" }))).toBe(
      "Requirement 3: make_explicit_quote has characters that aren't text (control characters). Copy it from the résumé as plain text.",
    );
  });

  it(`caps the suggestion at ${MAX_MAKE_EXPLICIT_CHARS} characters and its quote like an evidence quote`, () => {
    expect(MAX_MAKE_EXPLICIT_CHARS).toBe(300);
    expect(
      parseOk(withSuggestion({ make_explicit: "😀".repeat(MAX_MAKE_EXPLICIT_CHARS), make_explicit_quote: QUOTE })).requirements[2]
        ?.make_explicit,
    ).toHaveLength(MAX_MAKE_EXPLICIT_CHARS * 2);
    expect(parseError(withSuggestion({ make_explicit: "x".repeat(MAX_MAKE_EXPLICIT_CHARS + 1), make_explicit_quote: QUOTE }))).toBe(
      `Requirement 3: make_explicit is ${MAX_MAKE_EXPLICIT_CHARS + 1} characters; the limit is ${MAX_MAKE_EXPLICIT_CHARS}. Keep it to one short sentence.`,
    );
    expect(
      parseError(withSuggestion({ make_explicit: SUGGESTION, make_explicit_quote: "a".repeat(MAX_EVIDENCE_QUOTE_CHARS + 1) })),
    ).toBe(
      `Requirement 3: make_explicit_quote is ${(MAX_EVIDENCE_QUOTE_CHARS + 1).toLocaleString("en-US")} characters; the limit is ${MAX_EVIDENCE_QUOTE_CHARS.toLocaleString("en-US")}. Quote a shorter passage.`,
    );
  });

  it("a JSON-string answer at every limit, with every suggestion filled, still fits under the JSON cap", () => {
    const requirement = {
      text: "r".repeat(MAX_REQUIREMENT_TEXT_CHARS),
      status: "partial",
      evidence_quote: "q".repeat(MAX_EVIDENCE_QUOTE_CHARS),
      make_explicit: "m".repeat(MAX_MAKE_EXPLICIT_CHARS),
      make_explicit_quote: "e".repeat(MAX_EVIDENCE_QUOTE_CHARS),
    };
    const largest = JSON.stringify({
      ...valid(),
      requirements: Array(MAX_REQUIREMENTS).fill(requirement),
      criteria: Array(5).fill({ label: "l".repeat(200), status: "met", reason: "w".repeat(MAX_REASON_CHARS) }),
      red_flags: Array(MAX_RED_FLAGS).fill("f".repeat(MAX_RED_FLAG_CHARS)),
      summary: "s".repeat(MAX_SUMMARY_CHARS),
    });
    expect(largest.length).toBeLessThanOrEqual(MAX_RESULT_JSON_CHARS);
    expect(parseOk(largest).requirements).toHaveLength(MAX_REQUIREMENTS);
  });
});

describe("matchCriteriaLabels", () => {
  const saved = ["Pay floor", "Fully remote"];
  const result = (labels: string[]) =>
    labels.map((label) => ({ label, status: "met" as const, reason: "Yes." }));

  it("accepts one result per saved criterion and returns them in the saved order, with the saved labels", () => {
    const matched = matchCriteriaLabels(result(["fully  REMOTE", "Pay floor"]), saved);
    expect(matched).toEqual({
      ok: true,
      criteria: [
        { label: "Pay floor", status: "met", reason: "Yes." },
        { label: "Fully remote", status: "met", reason: "Yes." },
      ],
    });
  });

  it("matches labels the way set_criteria compares them (case, spacing, fullwidth letters)", () => {
    expect(matchCriteriaLabels(result(["ＰＡＹ floor", "fully remote"]), saved).ok).toBe(true);
  });

  it("rejects a label that is not saved", () => {
    expect(matchCriteriaLabels(result(["Pay floor", "Salary"]), saved)).toEqual({
      ok: false,
      message:
        'criteria has "Salary", which is not a saved criterion. Use the saved labels exactly: "Pay floor", "Fully remote".',
    });
  });

  it("rejects a criterion that has no result", () => {
    expect(matchCriteriaLabels(result(["Pay floor"]), saved)).toEqual({
      ok: false,
      message: 'criteria has no result for "Fully remote". Give one result for each saved criterion.',
    });
  });

  it("rejects two results for the same criterion", () => {
    expect(matchCriteriaLabels(result(["Pay floor", "pay floor"]), saved)).toEqual({
      ok: false,
      message: 'criteria has "pay floor" twice. Give one result for each saved criterion.',
    });
  });

  it("with no saved criteria, accepts only an empty list", () => {
    expect(matchCriteriaLabels([], [])).toEqual({ ok: true, criteria: [] });
    expect(matchCriteriaLabels(result(["Pay floor"]), [])).toEqual({
      ok: false,
      message: "No criteria are saved, so criteria must be an empty list.",
    });
  });
});
