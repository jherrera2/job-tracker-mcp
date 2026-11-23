// Rules for the user's top-5 criteria (PRD 01 §2 story 2) and the starter suggestion list.
// Pure functions, no database; the tools are tested end to end in test/integration/criteria-tools.test.ts.
import { describe, expect, it } from "vitest";
import {
  CRITERIA_SUGGESTIONS,
  MAX_CRITERIA,
  MAX_DETAIL_CHARS,
  MAX_LABEL_CHARS,
  parseCriteria,
} from "../../src/domain/criteria.js";

const PAY = { label: "Pay floor", detail: "Base pay of at least $140k." };
const REMOTE = { label: "Fully remote", detail: "100% remote, US time zones." };

/** n distinct, valid criteria. */
function criteria(n: number): { label: string; detail: string }[] {
  return Array.from({ length: n }, (_, i) => ({ label: `Criterion ${i + 1}`, detail: `Detail number ${i + 1}.` }));
}

describe("limits", () => {
  it("are 1–5 criteria, labels up to 80 characters, details up to 300", () => {
    expect(MAX_CRITERIA).toBe(5);
    expect(MAX_LABEL_CHARS).toBe(80);
    expect(MAX_DETAIL_CHARS).toBe(300);
  });
});

describe("CRITERIA_SUGGESTIONS", () => {
  it("has the 12 common criteria from the PRD, in order", () => {
    expect(CRITERIA_SUGGESTIONS.map((s) => s.key)).toEqual([
      "pay_floor",
      "fully_remote",
      "no_weekends_on_call",
      "independence",
      "growth_learning",
      "ai_forward_team",
      "company_size",
      "industry",
      "title_level",
      "benefits",
      "commute",
      "stability",
    ]);
  });

  it("gives every suggestion a label and an example", () => {
    for (const s of CRITERIA_SUGGESTIONS) {
      expect(s.label.trim(), s.key).not.toBe("");
      expect(s.example.trim(), s.key).not.toBe("");
    }
  });

  it("has unique keys and unique labels (ignoring case)", () => {
    expect(new Set(CRITERIA_SUGGESTIONS.map((s) => s.key)).size).toBe(CRITERIA_SUGGESTIONS.length);
    expect(new Set(CRITERIA_SUGGESTIONS.map((s) => s.label.toLowerCase())).size).toBe(CRITERIA_SUGGESTIONS.length);
  });

  it("can be saved as-is: each label + example passes set_criteria's own rules", () => {
    for (const s of CRITERIA_SUGGESTIONS) {
      expect(parseCriteria([{ label: s.label, detail: s.example }]), s.key).toMatchObject({ ok: true });
    }
  });
});

describe("parseCriteria", () => {
  it("accepts 1 criterion", () => {
    expect(parseCriteria([PAY])).toEqual({ ok: true, criteria: [PAY] });
  });

  it("accepts 5 criteria and keeps their order", () => {
    const five = criteria(5);
    expect(parseCriteria(five)).toEqual({ ok: true, criteria: five });
  });

  it("rejects an empty list", () => {
    expect(parseCriteria([])).toEqual({
      ok: false,
      message: "Send at least 1 criterion (up to 5).",
    });
  });

  it("rejects more than 5", () => {
    expect(parseCriteria(criteria(6))).toEqual({
      ok: false,
      message: "You sent 6 criteria; the limit is 5. Keep the 5 that matter most.",
    });
  });

  it("trims blank space at the ends of the label and detail, and keeps the words as written", () => {
    expect(parseCriteria([{ label: "  Pay floor \n", detail: "\tBase pay of at least $140k.  " }])).toEqual({
      ok: true,
      criteria: [PAY],
    });
  });

  it.each([
    ["empty", ""],
    ["blank", "   \n\t "],
  ])("rejects an %s label, naming which criterion", (_name, label) => {
    expect(parseCriteria([PAY, { label, detail: "Something." }])).toEqual({
      ok: false,
      message: 'Criterion 2 needs a label: a short name like "Pay floor".',
    });
  });

  it.each([
    ["empty", ""],
    ["blank", "   \n\t "],
  ])("rejects an %s detail, naming which criterion", (_name, detail) => {
    expect(parseCriteria([{ label: "Fully remote", detail }])).toEqual({
      ok: false,
      message: "Criterion 1 needs a detail: what it means to you, in your own words.",
    });
  });

  it("accepts a label of exactly 80 characters and rejects 81", () => {
    expect(parseCriteria([{ label: "a".repeat(80), detail: "ok" }])).toMatchObject({ ok: true });
    expect(parseCriteria([PAY, REMOTE, { label: "a".repeat(81), detail: "ok" }])).toEqual({
      ok: false,
      message: "Criterion 3's label is 81 characters; the limit is 80. Keep the label short and put the rest in the detail.",
    });
  });

  it("accepts a detail of exactly 300 characters and rejects 301", () => {
    expect(parseCriteria([{ label: "Pay floor", detail: "a".repeat(300) }])).toMatchObject({ ok: true });
    expect(parseCriteria([{ label: "Pay floor", detail: "a".repeat(301) }])).toEqual({
      ok: false,
      message: "Criterion 1's detail is 301 characters; the limit is 300. Keep the part that matters most.",
    });
  });

  it("counts characters as a person does: 300 emoji is within the detail limit", () => {
    const detail = "😀".repeat(300); // 600 UTF-16 units
    expect(parseCriteria([{ label: "Vibes", detail }])).toEqual({ ok: true, criteria: [{ label: "Vibes", detail }] });
  });

  it("measures length after trimming the ends", () => {
    const detail = `   ${"a".repeat(300)}   `;
    expect(parseCriteria([{ label: "Pay floor", detail }])).toMatchObject({ ok: true });
  });

  it.each([
    ["case", "pay FLOOR"],
    ["blank space at the ends", "  Pay floor  "],
  ])("rejects duplicate labels that differ only by %s", (_name, second) => {
    expect(parseCriteria([PAY, REMOTE, { label: second, detail: "Other words." }])).toEqual({
      ok: false,
      message: 'Criteria 1 and 3 have the same label ("Pay floor"). Give each one its own label.',
    });
  });

  // The comparison key: NFKC normalization, whitespace runs collapsed, full case folding.
  it.each([
    ["two spaces between words", "Pay floor", "Pay  floor"],
    ["a no-break space (U+00A0)", "Pay floor", "Pay\u00A0floor"],
    ["an ideographic space (U+3000)", "Pay floor", "Pay\u3000floor"],
    // Fails if NFC is used instead of NFKC: fullwidth letters only fold to plain ones under NFKC.
    ["fullwidth letters (NFKC)", "Pay", "\uFF30\uFF41\uFF59"],
    ["ß vs SS (full case folding)", "Straße", "STRASSE"],
    ["ß vs ss", "Straße", "strasse"],
    ["Greek final sigma", "ΟΔΟΣ", "οδος"],
    // Fails if folding is upper-then-lower only: capital sharp S (U+1E9E) upper-cases to itself
    // and lower-cases to "ß", never reaching "ss".
    ["capital sharp S vs ß", "Straße", "STRA\u1E9EE"],
    ["capital sharp S vs SS", "STRA\u1E9EE", "STRASSE"],
    // Turkish dotted capital İ (U+0130) folds to "i" + a combining dot, the same as its lower form.
    ["dotted capital I vs its lower form", "\u0130stanbul", "i\u0307stanbul"],
    // Fails if normalization is removed: "é" as one code point vs "e" + a combining accent.
    ["a precomposed vs a combining accent (NFC)", "Caf\u00E9", "Cafe\u0301"],
    // Also NFKC-only: a superscript digit folds to the plain digit (case folding can't do this).
    ["a superscript digit (NFKC)", "Level 2", "Level \u00B2"],
    ["a ligature", "Fixed hours", "\uFB01xed hours"],
  ])("rejects duplicate labels that differ only by %s", (_name, first, second) => {
    expect(parseCriteria([{ label: first, detail: "One." }, { label: second, detail: "Two." }])).toEqual({
      ok: false,
      message: `Criteria 1 and 2 have the same label ("${first}"). Give each one its own label.`,
    });
  });

  // Fails if dotless ı is folded through upper case: "ı" upper-cases to "I", which would make
  // "ı" and "i" (two different Turkish letters) the same label. Full case folding keeps them apart.
  it("does not treat dotless ı and i as the same letter", () => {
    expect(
      parseCriteria([
        { label: "Kırmızı", detail: "One." },
        { label: "Kirmizi", detail: "Two." },
        { label: "KIRMIZI", detail: "Three." },
      ]),
    ).toEqual({
      ok: false,
      message: 'Criteria 2 and 3 have the same label ("Kirmizi"). Give each one its own label.',
    });
  });

  it("does not treat labels that merely share letters as duplicates", () => {
    expect(
      parseCriteria([
        { label: "Pay floor", detail: "One." },
        { label: "Payfloor", detail: "Two." },
        { label: "Pay floors", detail: "Three." },
      ]),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ["a line feed", "Pay\nfloor"],
    ["a carriage return", "Pay\rfloor"],
    ["a Windows line break", "Pay\r\nfloor"],
    ["a tab", "Pay\tfloor"],
    ["a form feed", "Pay\ffloor"],
    ["a line separator (U+2028)", "Pay\u2028floor"],
    ["a paragraph separator (U+2029)", "Pay\u2029floor"],
  ])("rejects a label containing %s", (_name, label) => {
    expect(parseCriteria([REMOTE, { label, detail: "ok" }])).toEqual({
      ok: false,
      message: "Criterion 2's label must be one line, with no line breaks or tabs.",
    });
  });

  it.each([
    ["a zero-width space (U+200B)", "Pay\u200Bfloor"],
    ["a right-to-left override (U+202E)", "Pay \u202Efloor"],
    ["a soft hyphen (U+00AD)", "Pay\u00ADfloor"],
    ["a word joiner (U+2060)", "Pay\u2060floor"],
    ["a byte-order mark inside (U+FEFF)", "Pay\uFEFFfloor"],
    ["a left-to-right embedding (U+202A)", "\u202APay floor"],
    ["a pop directional formatting (U+202C)", "Pay floor\u202C"],
    ["a left-to-right isolate (U+2066)", "Pay \u2066floor"],
    ["a pop directional isolate (U+2069)", "Pay floor\u2069"],
  ])("rejects a label containing a risky invisible character: %s", (_name, label) => {
    expect(parseCriteria([{ label, detail: "ok" }])).toEqual({
      ok: false,
      message:
        "Criterion 1's label has invisible formatting characters (like a zero-width space). Type the label again as plain text.",
    });
  });

  it.each([
    ["zero-width spaces", "\u200B\u200B"],
    ["a right-to-left override and a space", "\u202E "],
    ["line breaks and tabs", "\n\t\r\n"],
    ["a mix", " \u200B\n\u2060\t "],
    ["joiners and direction marks (allowed characters, but nothing visible)", "\u200D\u200C\u200E\u200F"],
    ["a Hangul filler (U+3164)", "\u3164"],
    ["Hangul fillers (U+115F, U+1160, U+FFA0)", "\u115F\u1160\uFFA0"],
    ["a blank Braille pattern (U+2800)", "\u2800\u2800"],
    ["bare combining accents", "\u0301\u0301"],
  ])("treats a label made only of %s as empty", (_name, label) => {
    expect(parseCriteria([PAY, { label, detail: "ok" }])).toEqual({
      ok: false,
      message: 'Criterion 2 needs a label: a short name like "Pay floor".',
    });
  });

  // Real labels that need invisible joiners, direction marks or tag characters to be written correctly.
  it.each([
    ["an emoji built with zero-width joiners", "\u{1F469}\u200D\u{1F4BB} Remote"],
    ["Persian with a zero-width non-joiner (U+200C)", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"],
    ["Hebrew with a right-to-left mark (U+200F)", "\u05E9\u05DB\u05E8 \u200F100k"],
    ["Hebrew with a left-to-right mark (U+200E)", "\u05E9\u05DB\u05E8 \u200E100k"],
    ["the England flag (tag characters)", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} Office"],
    ["a single visible symbol", "$"],
    ["a single digit", "5"],
    ["a letter with a combining accent", "e\u0301"],
  ])("accepts %s, unchanged", (_name, label) => {
    expect(parseCriteria([{ label, detail: "ok" }])).toEqual({ ok: true, criteria: [{ label, detail: "ok" }] });
  });

  it.each([
    ["a trailing zero-width joiner", "Pay floor", "Pay floor\u200D"],
    ["a zero-width non-joiner inside a word", "Remote", "Re\u200Cmote"],
    ["a right-to-left mark", "\u05E9\u05DB\u05E8 100k", "\u05E9\u05DB\u05E8 \u200F100k"],
    ["tag characters", "\u{1F3F4} Office", "\u{1F3F4}\u{E0067}\u{E0062}\u{E007F} Office"],
  ])("treats labels that differ only by an invisible allowed character as duplicates: %s", (_name, first, second) => {
    expect(parseCriteria([{ label: first, detail: "One." }, { label: second, detail: "Two." }])).toEqual({
      ok: false,
      message: `Criteria 1 and 2 have the same label ("${first}"). Give each one its own label.`,
    });
  });

  it.each([
    ["a vertical tab", "Pay\vfloor"],
    ["a C1 next-line (U+0085)", "Pay\u0085floor"],
  ])("rejects a label containing %s (caught first as raw bytes)", (_name, label) => {
    expect(parseCriteria([{ label, detail: "ok" }])).toEqual({
      ok: false,
      message: "Criterion 1 looks like a file's raw contents, not text. Write it in your own words.",
    });
  });

  it("still allows line breaks in a detail, and in a label only at the ends (trimmed)", () => {
    expect(parseCriteria([{ label: "\nPay floor\n", detail: "Line one.\r\nLine two." }])).toEqual({
      ok: true,
      criteria: [{ label: "Pay floor", detail: "Line one.\r\nLine two." }],
    });
  });

  it.each([
    ["label", { label: "Pay\u0085floor", detail: "ok" }],
    ["detail", { label: "Pay floor", detail: "ok\u009B31m" }],
  ])("rejects a C1 control character in the %s (raw bytes)", (_name, item) => {
    expect(parseCriteria([item])).toEqual({
      ok: false,
      message: "Criterion 1 looks like a file's raw contents, not text. Write it in your own words.",
    });
  });

  it("allows the same detail under two different labels", () => {
    const result = parseCriteria([
      { label: "Pay floor", detail: "Same." },
      { label: "Benefits", detail: "Same." },
    ]);
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ["label", { label: "Pay\u0000floor", detail: "ok" }],
    ["detail", { label: "Pay floor", detail: "ok\u001B[0m" }],
    ["detail with a lone half of an emoji", { label: "Pay floor", detail: "ok \uD83D" }],
  ])("rejects raw file bytes / broken text in the %s", (_name, item) => {
    expect(parseCriteria([REMOTE, item])).toEqual({
      ok: false,
      message: "Criterion 2 looks like a file's raw contents, not text. Write it in your own words.",
    });
  });

  it("allows line breaks and tabs in a detail", () => {
    const detail = "Remote first.\nOffice once a quarter is fine.\tNo relocation.";
    expect(parseCriteria([{ label: "Fully remote", detail }])).toEqual({
      ok: true,
      criteria: [{ label: "Fully remote", detail }],
    });
  });

  it("reports the first problem only, in list order", () => {
    expect(parseCriteria([{ label: "", detail: "" }, { label: "a".repeat(81), detail: "" }])).toEqual({
      ok: false,
      message: 'Criterion 1 needs a label: a short name like "Pay floor".',
    });
  });
});
