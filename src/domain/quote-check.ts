// The word-for-word evidence check (PRD 01 §2 story 4, §6 "No invented facts"). Every
// evidence_quote in a fit check must appear in the master résumé version that fit check used; a
// quote that doesn't is dropped and its requirement becomes "missing". Pure code, no database
// (test/unit/quote-check.test.ts).
//
// What "word for word" means here (DECISIONS, step 6 proposed). Both texts are normalised the same
// way before comparing, so differences a reader can't see, or that copy-paste and typography
// create, don't count:
// - blank space: every run of spaces, tabs, line breaks or no-break spaces is one space, and the
//   quote's ends are trimmed (a résumé bullet wraps over two lines; the quote joins them);
// - invisible format characters (\p{Cf}: zero-width space, soft hyphen, byte-order mark…) are
//   removed (PDF copies are full of them);
// - curly quotes and apostrophes ‘ ’ ‚ ‛ ′ / “ ” „ ‟ ″ become ' and "; the dashes ‐ ‑ ‒ – — ― and
//   minus − become "-" (models often retype these);
// - accents are composed (NFC), so "é" typed as one character or as "e" + accent is the same.
// Everything else must match exactly, INCLUDING letter case, punctuation and Markdown symbols
// (`**bold**`), because the résumé is stored as raw Markdown and the answer rules tell the model
// to copy it character for character.
// On top of that:
// - a quote that starts (ends) with a letter or digit must start (end) on a word boundary, so
//   "Java" is not found inside "JavaScript";
// - a quote that starts (ends) with a digit may not start (end) right after (before) a "." or ","
//   that has a digit on its other side: that would cut a number at its decimal point or thousands
//   comma, so "5 years" is not found inside "1.5 years" and "5M" not inside "$2.5M" (tester M1).
//   "2019." at the end of a sentence still matches. The same holds when the quote's edge IS the
//   separator: "$2." is not found in "$2.5M", nor ".5 years" in "1.5 years" (Copilot, PR #6), but
//   "in 2019, then" and "Joined in 2019." still are;
// - a quote needs at least 2 characters, one of them a letter or digit ("a" or "--" prove nothing).
//
// Speed: the résumé is normalised ONCE per save (a few linear regex passes), then each quote is a
// String.indexOf search (V8's is Boyer–Moore based) plus an O(1) boundary check per candidate
// position. Nothing builds a per-character array.
import type { FitRequirement } from "./fit-result.js";
import { countChars } from "./master-resume.js";

const FORMAT_CHARACTERS = /\p{Cf}/gu;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const BLANK_RUNS = /\s+/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// A character that continues a word: a letter, a digit, or an accent mark attached to one.
const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}]$/u;
const DIGIT = /^\p{Nd}$/u;
// Characters that join the digits of one number: 1.5, 12,000.
const NUMBER_SEPARATORS = new Set([".", ","]);

export const MIN_QUOTE_CHARS = 2;
/** A make_explicit_quote must name a real fact: at least this many words… (rework M1) */
export const MIN_SUGGESTION_QUOTE_WORDS = 3;
/** …and at least this many visible characters (blank space and invisible characters don't count). */
export const MIN_SUGGESTION_QUOTE_CHARS = 15;

/** The normalised form both the résumé and each quote are compared in (see the rules above). */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .replace(FORMAT_CHARACTERS, "")
    .normalize("NFC")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(BLANK_RUNS, " ")
    .trim();
}

/** True when the code point is a letter, digit or combining mark. */
function isWordCodePoint(codePoint: number | undefined): boolean {
  return codePoint !== undefined && WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

function isDigitCodePoint(codePoint: number | undefined): boolean {
  return codePoint !== undefined && DIGIT.test(String.fromCodePoint(codePoint));
}

/** The code point that ends just before index `i` (handles a surrogate pair), or undefined at the start. */
function codePointBefore(text: string, i: number): number | undefined {
  if (i <= 0) return undefined;
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(i - 2);
  }
  return low;
}

/**
 * Prepares the résumé once and returns a function that answers "does this quote appear in it,
 * word for word?" for any number of quotes.
 */
export function createQuoteMatcher(resumeText: string): (quote: string) => boolean {
  const source = normalizeForQuoteCheck(resumeText);

  return (quote: string): boolean => {
    const needle = normalizeForQuoteCheck(quote);
    if (needle.length < MIN_QUOTE_CHARS || countChars(needle) < MIN_QUOTE_CHARS || !LETTER_OR_DIGIT.test(needle)) {
      return false;
    }
    const boundaryAtStart = isWordCodePoint(needle.codePointAt(0));
    const boundaryAtEnd = isWordCodePoint(codePointBefore(needle, needle.length));
    const digitAtStart = isDigitCodePoint(needle.codePointAt(0));
    const digitAtEnd = isDigitCodePoint(codePointBefore(needle, needle.length));
    // The quote's own edge is a separator next to a digit: "$2." or ".5 years".
    const separatorAfterDigitAtEnd =
      NUMBER_SEPARATORS.has(needle.charAt(needle.length - 1)) && isDigitCodePoint(codePointBefore(needle, needle.length - 1));
    const separatorBeforeDigitAtStart = NUMBER_SEPARATORS.has(needle.charAt(0)) && isDigitCodePoint(needle.codePointAt(1));

    // Each indexOf continues from the last candidate, so the whole loop is one pass over the résumé.
    // The checks per candidate look at most two characters on each side: O(1).
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const startOk =
        (!boundaryAtStart || !isWordCodePoint(codePointBefore(source, at))) &&
        // "5 years" inside "1.5 years": a "." or "," before the quote with a digit before that.
        !(digitAtStart && NUMBER_SEPARATORS.has(source.charAt(at - 1)) && isDigitCodePoint(codePointBefore(source, at - 1))) &&
        // ".5 years" inside "1.5 years": the quote starts with the separator, a digit before it.
        !(separatorBeforeDigitAtStart && isDigitCodePoint(codePointBefore(source, at)));
      const endOk =
        (!boundaryAtEnd || !isWordCodePoint(source.codePointAt(end))) &&
        // "Served 12" inside "Served 12,000": a "." or "," after the quote with a digit after that.
        !(digitAtEnd && NUMBER_SEPARATORS.has(source.charAt(end)) && isDigitCodePoint(source.codePointAt(end + 1))) &&
        // "$2." inside "$2.5M": the quote ends with the separator, a digit after it.
        !(separatorAfterDigitAtEnd && isDigitCodePoint(source.codePointAt(end)));
      if (startOk && endOk) return true;
    }
    return false;
  };
}

/** A quote the check removed, reported back so the user can see what was not found. */
export interface DroppedQuote {
  /** 1-based position of the requirement in the answer. */
  requirement: number;
  text: string;
  /** The status the model gave before the quote was dropped. */
  status: "met" | "partial";
  evidence_quote: string;
}

/**
 * True when a make_explicit_quote is long enough to ground a fact (rework M1): in the quote check's
 * normalised form, at least 3 words (space-separated runs holding a letter or digit) and at least 15
 * visible characters. "the" is in every résumé, so a quote like that grounds nothing.
 */
export function isMeaningfulSuggestionQuote(quote: string): boolean {
  const normalised = normalizeForQuoteCheck(quote);
  const words = normalised.split(" ").filter((word) => LETTER_OR_DIGIT.test(word)).length;
  const visible = countChars(normalised.replace(/ /g, ""));
  return words >= MIN_SUGGESTION_QUOTE_WORDS && visible >= MIN_SUGGESTION_QUOTE_CHARS;
}

/** A make_explicit suggestion the check removed because its quote is not in the résumé (step 11). */
export interface DroppedSuggestion {
  /** 1-based position of the requirement in the answer. */
  requirement: number;
  text: string;
  make_explicit: string;
  make_explicit_quote: string;
}

/**
 * Checks every evidence quote against the résumé. A requirement whose quote is not found becomes
 * { text, status: "missing" } (no quote), as PRD §2.4 says; the rest are returned unchanged.
 *
 * A "met" or "partial" requirement with NO quote also becomes "missing" (defence in depth, step 6
 * tester Low): parseFitResult already refuses one, but the rule "no evidence = not met" belongs to
 * this check, not to whoever called it first. It is not listed in `dropped`, which reports quotes,
 * and there is none to report.
 *
 * Step 11: a "partial" requirement that survives may carry a make_explicit suggestion. Its
 * make_explicit_quote goes through the SAME matcher, and must also be meaningful (at least 3 words
 * and 15 visible characters, rework M1); when it is not found or too trivial, the SUGGESTION is
 * dropped (reported in `droppedSuggestions`) and the requirement stays partial with its evidence.
 * A suggestion on any other status, a half-given one, or one on a partial whose evidence was
 * dropped (it is "missing" now, so there is nothing to make explicit) is removed without a report:
 * no suggestion quote was checked, so none failed.
 */
export function checkEvidence(
  requirements: readonly FitRequirement[],
  resumeText: string,
): { requirements: FitRequirement[]; dropped: DroppedQuote[]; droppedSuggestions: DroppedSuggestion[] } {
  const appears = createQuoteMatcher(resumeText);
  const dropped: DroppedQuote[] = [];
  const droppedSuggestions: DroppedSuggestion[] = [];
  const checked = requirements.map((requirement, index): FitRequirement => {
    if (requirement.status === "missing") return { text: requirement.text, status: "missing" };
    if (requirement.evidence_quote === undefined) return { text: requirement.text, status: "missing" };
    if (!appears(requirement.evidence_quote)) {
      dropped.push({
        requirement: index + 1,
        text: requirement.text,
        status: requirement.status,
        evidence_quote: requirement.evidence_quote,
      });
      return { text: requirement.text, status: "missing" };
    }
    const kept: FitRequirement = { text: requirement.text, status: requirement.status, evidence_quote: requirement.evidence_quote };
    const { make_explicit: suggestion, make_explicit_quote: quote } = requirement;
    if (requirement.status !== "partial" || suggestion === undefined || quote === undefined) return kept;
    // Proves the quote is in the résumé, NOT that the suggestion sentence follows from it (known limit).
    if (isMeaningfulSuggestionQuote(quote) && appears(quote)) return { ...kept, make_explicit: suggestion, make_explicit_quote: quote };
    droppedSuggestions.push({ requirement: index + 1, text: requirement.text, make_explicit: suggestion, make_explicit_quote: quote });
    return kept;
  });
  return { requirements: checked, dropped, droppedSuggestions };
}
