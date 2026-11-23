// The word-for-word evidence check (PRD 01 §2 story 4, §6): every evidence_quote must appear in
// the master résumé version the fit check used. A quote that doesn't is dropped and its
// requirement becomes "missing".
//
// "Word for word" is defined here (DECISIONS, step 6 proposed):
// - SAME: blank space (spaces, tabs, line breaks, no-break spaces; runs count as one space; the
//   quote's ends are trimmed), invisible format characters (zero-width space, soft hyphen…),
//   curly vs straight quotes and apostrophes, dash variants (– — ‐ −) vs "-", and composed vs
//   decomposed accents (NFC).
// - DIFFERENT: letter case, any word or punctuation change, "..." splices, Markdown symbols
//   (**bold**) the résumé has and the quote leaves out, and a match inside a longer word ("Java"
//   is not found in "JavaScript").
// - A quote must hold at least 2 characters and a letter or digit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkEvidence,
  createQuoteMatcher,
  isMeaningfulSuggestionQuote,
  MIN_SUGGESTION_QUOTE_CHARS,
  MIN_SUGGESTION_QUOTE_WORDS,
  normalizeForQuoteCheck,
} from "../../src/domain/quote-check.js";

const RESUME = readFileSync(new URL("../fixtures/fit/master-resume.md", import.meta.url), "utf8");

describe("normalizeForQuoteCheck", () => {
  it("collapses blank space, trims, folds quotes and dashes, removes invisible characters, composes accents", () => {
    expect(normalizeForQuoteCheck("  a\n\t b\u00A0 c  ")).toBe("a b c");
    expect(normalizeForQuoteCheck("it\u2019s \u201Cfine\u201D")).toBe('it\'s "fine"');
    expect(normalizeForQuoteCheck("\u2018a\u2019 \u201Ab\u201B 5\u2032 6\u2033 \u201Ec\u201F")).toBe("'a' 'b' 5' 6\" \"c\"");
    expect(normalizeForQuoteCheck("2017\u20132021 \u2014 x\u2010y \u2212 z")).toBe("2017-2021 - x-y - z");
    expect(normalizeForQuoteCheck("co\u00ADor\u200Bdi\uFEFFnate")).toBe("coordinate");
    expect(normalizeForQuoteCheck("Re\u0301sume\u0301")).toBe("R\u00E9sum\u00E9");
  });

  it("keeps letter case", () => {
    expect(normalizeForQuoteCheck("TypeScript")).toBe("TypeScript");
  });
});

describe("createQuoteMatcher", () => {
  const appears = createQuoteMatcher(RESUME);

  it("finds a passage copied exactly", () => {
    expect(appears("Led the migration from MySQL to PostgreSQL with zero downtime.")).toBe(true);
  });

  it("finds a passage that runs over a line break in the résumé", () => {
    expect(appears("serving 2 million requests a day for the patient-scheduling product.")).toBe(true);
  });

  it("ignores extra blank space and blank space at the ends of the quote", () => {
    expect(appears("  Mentored  four junior\nengineers  ")).toBe(true);
  });

  it("treats curly and straight quotes, and dash variants, as the same", () => {
    const resume = createQuoteMatcher("I\u2019m the \u201Cgo-to\u201D person for 2019\u20132021 releases.");
    expect(resume("I'm the \"go-to\" person for 2019-2021 releases.")).toBe(true);
    const straight = createQuoteMatcher("I'm the go-to person, 2019-2021.");
    expect(straight("I\u2019m the go\u2013to person, 2019\u20142021.")).toBe(true);
  });

  it("treats composed and decomposed accents as the same", () => {
    expect(createQuoteMatcher("Built the caf\u00E9 app.")("cafe\u0301 app")).toBe(true);
  });

  it("ignores invisible characters left by a PDF copy", () => {
    expect(createQuoteMatcher("Mentored four ju\u00ADnior engi\u200Bneers.")("four junior engineers")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(appears("led the migration from mysql to postgresql")).toBe(false);
  });

  it("rejects a changed word (the fake-quote case)", () => {
    expect(appears("Led the migration from MySQL to PostgreSQL with no downtime.")).toBe(false);
    expect(appears("Ran production Kubernetes clusters for five years.")).toBe(false);
  });

  it('rejects a "..." splice of two real passages', () => {
    expect(appears("Built a TypeScript ... product.")).toBe(false);
    expect(appears("Built a TypeScript\u2026 product.")).toBe(false);
  });

  it("does not strip Markdown: the bold markers are part of the text", () => {
    expect(appears("**Senior Software Engineer**, Northwind Health")).toBe(true);
    expect(appears("Senior Software Engineer, Northwind Health")).toBe(false);
  });

  it("only matches whole words at the quote's ends", () => {
    expect(appears("Java")).toBe(false); // only inside "JavaScript"
    expect(appears("Script")).toBe(false);
    expect(appears("TypeScript")).toBe(true);
    expect(appears("Node.js")).toBe(true);
    expect(appears("(2017\u20132021)")).toBe(true);
  });

  it("does not cut a number at its decimal point or thousands comma", () => {
    // M1 (tester): "5 years" must not be found inside "1.5 years", nor "5M" inside "$2.5M".
    expect(createQuoteMatcher("I have 1.5 years of Go work.")("5 years of Go work")).toBe(false);
    expect(createQuoteMatcher("Grew to $2.5M ARR in a year.")("5M ARR")).toBe(false);
    expect(createQuoteMatcher("Grew revenue 2.5x in a year.")("Grew revenue 2")).toBe(false);
    expect(createQuoteMatcher("Served 12,000 users.")("000 users")).toBe(false);
    expect(createQuoteMatcher("Served 12,000 users.")("Served 12")).toBe(false);
    // Whole numbers still match, and so does a number next to sentence punctuation.
    expect(createQuoteMatcher("Grew to $2.5M ARR in a year.")("$2.5M ARR")).toBe(true);
    expect(createQuoteMatcher("Grew to $2.5M ARR in a year.")("2.5M ARR")).toBe(true);
    expect(createQuoteMatcher("Led 5 engineers. 3 shipped.")("Led 5 engineers. 3")).toBe(true);
    expect(createQuoteMatcher("Teams of 4, 5 or 6.")("5 or 6")).toBe(true);
    expect(createQuoteMatcher("Version 2.0 shipped in 2019.")("shipped in 2019")).toBe(true);
  });

  it("does not cut a number when the quote starts or ends with the separator itself (Copilot, PR #6)", () => {
    expect(createQuoteMatcher("Grew to $2.5M ARR in a year.")("Grew to $2.")).toBe(false);
    expect(createQuoteMatcher("Served 12,000 users.")("Served 12,")).toBe(false);
    expect(createQuoteMatcher("I have 1.5 years of Go work.")(".5 years of Go work")).toBe(false);
    expect(createQuoteMatcher("Served 12,000 users.")(",000 users")).toBe(false);
    // Sentence punctuation after a number still matches.
    expect(createQuoteMatcher("Joined in 2019. Then left.")("Joined in 2019.")).toBe(true);
    expect(createQuoteMatcher("Joined in 2019.")("Joined in 2019.")).toBe(true);
    expect(createQuoteMatcher("Joined in 2019, then left.")("in 2019, then")).toBe(true);
    expect(createQuoteMatcher("Joined in 2019, then left.")("in 2019,")).toBe(true);
    expect(createQuoteMatcher("Teams of 4, 5 or 6.")(", 5 or 6")).toBe(true);
  });

  it("keeps looking after a match inside a longer word", () => {
    expect(createQuoteMatcher("JavaScript and Java.")("Java")).toBe(true);
  });

  it("rejects quotes too short or too empty to be evidence", () => {
    expect(appears("")).toBe(false);
    expect(appears("   \n ")).toBe(false);
    expect(appears("a")).toBe(false);
    expect(appears("--")).toBe(false);
    // Even when the résumé really contains it: punctuation alone proves nothing.
    expect(createQuoteMatcher("Skills -- TypeScript, Go -- and SQL.")("--")).toBe(false);
    expect(createQuoteMatcher("Skills -- TypeScript, Go -- and SQL.")("-- and SQL")).toBe(true);
    expect(appears("\u200B\u200B")).toBe(false);
    // One character, even when it takes two UTF-16 units (a mathematical bold J).
    expect(createQuoteMatcher("Variable \u{1D409} is used.")("\u{1D409}")).toBe(false);
  });

  it("accepts a 2-character quote that is a whole word", () => {
    expect(createQuoteMatcher("Languages: Go, C#, Rust.")("Go")).toBe(true);
    expect(createQuoteMatcher("Languages: Go, C#, Rust.")("C#")).toBe(true);
  });

  describe("speed (linear work: no per-character arrays, no nested scans)", () => {
    it("checks 60 long quotes against a 60,000-character résumé quickly", () => {
      const resume = Array.from({ length: 12_000 }, (_, i) => `word${i}`).join(" ").slice(0, 60_000);
      // 60 passages of ~800 characters cut at spaces; every second one gets a word that isn't there.
      const quotes = Array.from({ length: 60 }, (_, i) => {
        const start = resume.indexOf(" ", i * 950) + 1;
        const passage = resume.slice(start, resume.indexOf(" ", start + 800));
        return i % 2 === 0 ? passage : `${passage} nope`;
      });
      const started = performance.now();
      const matcher = createQuoteMatcher(resume);
      const results = quotes.map(matcher);
      expect(performance.now() - started).toBeLessThan(250);
      expect(results.filter(Boolean)).toHaveLength(30);
    });

    it("stays fast on repetitive text that defeats naive searching", () => {
      const resume = "a ".repeat(30_000);
      const started = performance.now();
      const matcher = createQuoteMatcher(resume);
      expect(matcher(`${"a ".repeat(499)}b`)).toBe(false);
      expect(matcher(`b ${"a ".repeat(499)}`.trim())).toBe(false);
      expect(performance.now() - started).toBeLessThan(250);
    });

    it("stays fast when every occurrence sits inside a longer word", () => {
      const resume = "xab".repeat(20_000);
      const started = performance.now();
      expect(createQuoteMatcher(resume)("ab")).toBe(false);
      expect(performance.now() - started).toBeLessThan(250);
    });
  });
});

describe("checkEvidence", () => {
  it("keeps verified quotes, drops fake ones and marks those requirements missing", () => {
    const { requirements, dropped } = checkEvidence(
      [
        { text: "TypeScript", status: "met", evidence_quote: "TypeScript, JavaScript, Node.js" },
        { text: "Kubernetes", status: "met", evidence_quote: "Ran production Kubernetes clusters." },
        { text: "Mentoring", status: "partial", evidence_quote: "Mentored four junior engineers" },
        { text: "Go", status: "missing" },
      ],
      RESUME,
    );
    expect(requirements).toEqual([
      { text: "TypeScript", status: "met", evidence_quote: "TypeScript, JavaScript, Node.js" },
      { text: "Kubernetes", status: "missing" },
      { text: "Mentoring", status: "partial", evidence_quote: "Mentored four junior engineers" },
      { text: "Go", status: "missing" },
    ]);
    expect(dropped).toEqual([
      { requirement: 2, text: "Kubernetes", status: "met", evidence_quote: "Ran production Kubernetes clusters." },
    ]);
  });

  it("turns a met or partial requirement that has NO quote into missing (defence in depth; save_fit already refuses it)", () => {
    // parseFitResult refuses met/partial without a quote, so this only matters if a caller skips it.
    // There is no quote to report, so nothing is added to `dropped`.
    const { requirements, dropped } = checkEvidence(
      [
        { text: "Kubernetes", status: "met" },
        { text: "Mentoring", status: "partial" },
        { text: "TypeScript", status: "met", evidence_quote: "TypeScript, JavaScript, Node.js" },
      ],
      RESUME,
    );
    expect(requirements).toEqual([
      { text: "Kubernetes", status: "missing" },
      { text: "Mentoring", status: "missing" },
      { text: "TypeScript", status: "met", evidence_quote: "TypeScript, JavaScript, Node.js" },
    ]);
    expect(dropped).toEqual([]);
  });

  it("returns no drops when every quote is real", () => {
    const { dropped } = checkEvidence(
      [{ text: "Postgres", status: "met", evidence_quote: "Led the migration from MySQL to PostgreSQL" }],
      RESUME,
    );
    expect(dropped).toEqual([]);
  });
});

// Step 11: a make_explicit suggestion rests on make_explicit_quote, checked by the SAME word-for-word
// rule. A quote not found drops the SUGGESTION only: the requirement keeps its "partial" status and
// its evidence. Drops are reported in droppedSuggestions, like dropped quotes.
describe("checkEvidence — make_explicit suggestions (step 11)", () => {
  const SUGGESTION = "Name the twelve services you set up CI/CD for.";

  it("keeps a suggestion whose quote is in the résumé", () => {
    const requirement = {
      text: "CI/CD at scale",
      status: "partial" as const,
      evidence_quote: "Set up CI/CD pipelines in GitHub Actions",
      make_explicit: SUGGESTION,
      make_explicit_quote: "Set up CI/CD pipelines in GitHub Actions for twelve services.",
    };
    const { requirements, dropped, droppedSuggestions } = checkEvidence([requirement], RESUME);
    expect(requirements).toEqual([requirement]);
    expect(dropped).toEqual([]);
    expect(droppedSuggestions).toEqual([]);
  });

  it("drops a suggestion whose quote is invented; the requirement stays partial with its evidence", () => {
    const { requirements, dropped, droppedSuggestions } = checkEvidence(
      [
        { text: "TypeScript", status: "met", evidence_quote: "TypeScript, JavaScript, Node.js" },
        {
          text: "Kubernetes operations",
          status: "partial",
          evidence_quote: "Docker",
          make_explicit: "Say that you ran Kubernetes clusters in production.",
          make_explicit_quote: "Ran Kubernetes clusters in production.",
        },
      ],
      RESUME,
    );
    expect(requirements).toEqual([
      { text: "TypeScript", status: "met", evidence_quote: "TypeScript, JavaScript, Node.js" },
      { text: "Kubernetes operations", status: "partial", evidence_quote: "Docker" },
    ]);
    expect(dropped).toEqual([]);
    expect(droppedSuggestions).toEqual([
      {
        requirement: 2,
        text: "Kubernetes operations",
        make_explicit: "Say that you ran Kubernetes clusters in production.",
        make_explicit_quote: "Ran Kubernetes clusters in production.",
      },
    ]);
  });

  it("uses the same rule as evidence quotes: case-sensitive, whole words, blank space folded", () => {
    const partial = (quote: string) => ({
      text: "Mentoring",
      status: "partial" as const,
      evidence_quote: "Mentored four junior engineers",
      make_explicit: "Say how you mentored them.",
      make_explicit_quote: quote,
    });
    const kept = (quote: string) => checkEvidence([partial(quote)], RESUME).droppedSuggestions.length === 0;
    expect(kept("Mentored four junior engineers through weekly code reviews.")).toBe(true);
    expect(kept("Mentored  four\njunior engineers")).toBe(true);
    expect(kept("mentored four junior engineers")).toBe(false);
    expect(kept("Mentored four junior engineers through daily code reviews.")).toBe(false);
    expect(kept("Script")).toBe(false); // inside "TypeScript" / "JavaScript"
  });

  it("a requirement whose EVIDENCE quote is dropped becomes missing and loses its suggestion, which is not counted twice", () => {
    const { requirements, dropped, droppedSuggestions } = checkEvidence(
      [
        {
          text: "Go",
          status: "partial",
          evidence_quote: "Wrote Go services",
          make_explicit: "Mention the TypeScript API.",
          make_explicit_quote: "Built a TypeScript and Node.js API",
        },
      ],
      RESUME,
    );
    expect(requirements).toEqual([{ text: "Go", status: "missing" }]);
    expect(dropped).toEqual([{ requirement: 1, text: "Go", status: "partial", evidence_quote: "Wrote Go services" }]);
    expect(droppedSuggestions).toEqual([]);
  });

  it("strips a suggestion from a met or missing requirement (defence in depth; parseFitResult already drops it)", () => {
    const { requirements, droppedSuggestions } = checkEvidence(
      [
        {
          text: "TypeScript",
          status: "met",
          evidence_quote: "TypeScript, JavaScript, Node.js",
          make_explicit: "x",
          make_explicit_quote: "TypeScript",
        },
        { text: "Go", status: "missing", make_explicit: "x", make_explicit_quote: "TypeScript" },
      ],
      RESUME,
    );
    expect(requirements).toEqual([
      { text: "TypeScript", status: "met", evidence_quote: "TypeScript, JavaScript, Node.js" },
      { text: "Go", status: "missing" },
    ]);
    expect(droppedSuggestions).toEqual([]);
  });

  it("drops a half-given suggestion (one field without the other) without reporting it", () => {
    const { requirements, droppedSuggestions } = checkEvidence(
      [{ text: "Mentoring", status: "partial", evidence_quote: "Mentored four junior engineers", make_explicit: "Say more." }],
      RESUME,
    );
    expect(requirements).toEqual([{ text: "Mentoring", status: "partial", evidence_quote: "Mentored four junior engineers" }]);
    expect(droppedSuggestions).toEqual([]);
  });
});

// Rework M1: a trivial make_explicit_quote ("the") is found in any résumé, so it grounded nothing
// and let an invented suggestion through. A suggestion quote must hold at least 3 words AND at
// least 15 visible characters, counted after the quote check's normalisation; otherwise the
// suggestion is dropped and reported like a quote that is not found.
describe("checkEvidence — a suggestion quote must be meaningful (rework M1)", () => {
  const BILLING = "- Built the billing service for the clinic portal.\n- Wrote a guide.\n- Infrastructures";
  const INVENTED = "Say you led a 12-person team and own Terraform at AWS.";
  const withQuote = (quote: string) =>
    checkEvidence(
      [{ text: "Leadership", status: "partial", evidence_quote: "Built the billing service", make_explicit: INVENTED, make_explicit_quote: quote }],
      BILLING,
    );

  it("sets the floor at 3 words and 15 visible characters", () => {
    expect(MIN_SUGGESTION_QUOTE_WORDS).toBe(3);
    expect(MIN_SUGGESTION_QUOTE_CHARS).toBe(15);
  });

  it.each([
    ["the (the reviewer's repro)", "the"],
    ["a", "a"],
    ["a 2-word quote", "billing service"],
    ["a 15-character single token", "Infrastructures"],
    ["3 words but only 12 visible characters", "for the clinic"],
  ])("drops the suggestion and reports it when the quote is %s, even though it is in the résumé", (_name, quote) => {
    expect(createQuoteMatcher(BILLING)(quote)).toBe(quote.length >= 2);
    const { requirements, droppedSuggestions } = withQuote(quote);
    expect(requirements).toEqual([{ text: "Leadership", status: "partial", evidence_quote: "Built the billing service" }]);
    expect(droppedSuggestions).toEqual([{ requirement: 1, text: "Leadership", make_explicit: INVENTED, make_explicit_quote: quote }]);
  });

  it("keeps a quote with exactly 3 words and 15 visible characters", () => {
    expect(withQuote("the clinic portal").droppedSuggestions).toEqual([]);
    expect(withQuote("Built the billing service for the clinic portal.").droppedSuggestions).toEqual([]);
  });

  it("counts after normalisation: blank space and invisible characters are not visible characters, and a word needs a letter or digit", () => {
    expect(isMeaningfulSuggestionQuote("the clinic portal")).toBe(true);
    expect(isMeaningfulSuggestionQuote("  the \n clinic\u200B   portal ")).toBe(true);
    expect(isMeaningfulSuggestionQuote("the\u00AD\u200B clinic port")).toBe(false); // 13 visible
    expect(isMeaningfulSuggestionQuote("Infrastructures - --")).toBe(false); // 1 word: "-" and "--" are not words
    expect(isMeaningfulSuggestionQuote("abcde fghij klmno")).toBe(true);
  });
});
