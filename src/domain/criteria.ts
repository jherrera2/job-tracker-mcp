// The user's top-5 criteria (PRD 01 §2 story 2): the starter suggestion list, and the rules a
// saved set must follow. Pure code, no database, so it is unit-tested on its own
// (test/unit/criteria.test.ts).
//
// The rules:
// - 1 to 5 criteria. Saving replaces the whole set; the order sent is the order saved (positions 1..n).
// - Each has a label (a short name, ≤ 80 characters) and a detail in the user's own words
//   (≤ 300 characters, the PRD's limit). The label limit is ours: long enough for any suggestion
//   plus a qualifier ("No weekends / on-call except launch weeks"), short enough to stay a name.
// - Blank space at the ends is trimmed before checking and saving; the words are kept as written.
// - "Characters" are counted as a person counts them (an emoji is one), like the master résumé.
// - Two labels that read the same are the same criterion, so they are rejected: the fit check
//   reports one result per label, and two "Pay floor"s would be ambiguous. "Read the same" means
//   equal after NFKC normalization, collapsing runs of blank space, and full case folding (see
//   sameLabelKey), so "Pay  floor", fullwidth "Ｐａｙ floor" and "PAY FLOOR" all match "Pay floor".
// - A label is one line with at least one visible character. It may not hold line breaks, tabs
//   or the RISKY invisible characters (zero-width spaces, direction overrides...), which could make
//   two labels look identical or make a label display backwards. Invisible characters that real
//   writing needs (emoji joiners, Persian non-joiners, direction marks, flag tags) are allowed.
//   Details may span several lines.
// - Raw file bytes or broken text are rejected with the same rule as the master résumé.
import { countChars, formatNumber, hasVisibleChar, isPlainText, type ParseResult } from "./master-resume.js";

export const MIN_CRITERIA = 1;
export const MAX_CRITERIA = 5;
export const MAX_LABEL_CHARS = 80;
export const MAX_DETAIL_CHARS = 300;

export interface CriterionInput {
  label: string;
  detail: string;
}

export interface CriterionSuggestion {
  /** A stable id for the suggestion (snake_case). */
  key: string;
  /** A short name the user can save as the label. */
  label: string;
  /** An example detail, to show what "your own words" can look like. */
  example: string;
}

// The starter list (PRD 01 §2 story 2). Static data: it is the same for every user, and the
// user may write their own criteria instead. The examples are illustrations, not defaults.
export const CRITERIA_SUGGESTIONS: readonly CriterionSuggestion[] = [
  { key: "pay_floor", label: "Pay floor", example: "Base pay of at least $140k." },
  { key: "fully_remote", label: "Fully remote", example: "100% remote; travel no more than twice a year." },
  { key: "no_weekends_on_call", label: "No weekends / on-call", example: "No on-call rotation and no weekend work." },
  { key: "independence", label: "Independence", example: "I own my projects end to end without being micromanaged." },
  { key: "growth_learning", label: "Growth / learning", example: "A clear path to senior, and time to learn new tools." },
  { key: "ai_forward_team", label: "AI-forward team", example: "The team ships AI features and uses AI tools every day." },
  { key: "company_size", label: "Company size", example: "Between 50 and 1,000 people." },
  { key: "industry", label: "Industry", example: "Health care or education; no gambling or crypto." },
  { key: "title_level", label: "Title / level", example: "Senior or Lead title, not a step down." },
  { key: "benefits", label: "Benefits", example: "Good family health insurance and a 401(k) match." },
  { key: "commute", label: "Commute", example: "If not remote, under 30 minutes from home." },
  { key: "stability", label: "Stability", example: "Profitable or well funded; no recent layoffs." },
];

const LABEL_EXAMPLE = '"Pay floor"';

// Not allowed inside a label (after trimming the ends): anything that starts a new line or a tab
// stop. (\v and U+0085 are also control characters, so isPlainText rejects them first.)
const LINE_BREAK_OR_TAB = /[\n\r\t\f\v\u0085\p{Zl}\p{Zp}]/u;

// The risky invisible characters, rejected in a label:
// - U+202A–U+202E and U+2066–U+2069: bidirectional embeddings, overrides and isolates, which can
//   make a label DISPLAY in a different order than it is stored (the "Trojan Source" trick);
// - U+200B zero-width space, U+2060 word joiner, U+FEFF byte-order mark, U+00AD soft hyphen:
//   no job in a label except making two labels look the same while being different.
// Other invisible "format" characters (\p{Cf}) stay ALLOWED, because real text needs them:
// U+200D zero-width joiner builds emoji like 👩‍💻, U+200C zero-width non-joiner is part of Persian
// spelling, U+200E/U+200F direction marks place numbers correctly in Hebrew and Arabic, and tag
// characters (U+E0020–U+E007F) build flags such as England's.
const RISKY_INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u00AD]/u;


/**
 * Checks a set of criteria. On success the items come back trimmed, in the same order.
 * On failure, one sentence about the first problem found (in list order), shown to the user.
 */
export function parseCriteria(input: readonly CriterionInput[]): ParseResult<{ criteria: CriterionInput[] }> {
  if (input.length < MIN_CRITERIA) {
    return { ok: false, message: `Send at least ${MIN_CRITERIA} criterion (up to ${MAX_CRITERIA}).` };
  }
  if (input.length > MAX_CRITERIA) {
    return {
      ok: false,
      message: `You sent ${input.length} criteria; the limit is ${MAX_CRITERIA}. Keep the ${MAX_CRITERIA} that matter most.`,
    };
  }

  const criteria: CriterionInput[] = [];
  // Lower-cased label → its 1-based number, to find duplicates.
  const seen = new Map<string, number>();

  for (const [index, item] of input.entries()) {
    const n = index + 1;
    if (!isPlainText(item.label) || !isPlainText(item.detail)) {
      return { ok: false, message: `Criterion ${n} looks like a file's raw contents, not text. Write it in your own words.` };
    }

    const label = item.label.trim();
    const detail = item.detail.trim();

    // A label of only blank space, invisible characters or bare accents has nothing to read.
    if (!hasVisibleChar(label)) {
      return { ok: false, message: `Criterion ${n} needs a label: a short name like ${LABEL_EXAMPLE}.` };
    }
    if (LINE_BREAK_OR_TAB.test(label)) {
      return { ok: false, message: `Criterion ${n}'s label must be one line, with no line breaks or tabs.` };
    }
    if (RISKY_INVISIBLE.test(label)) {
      return {
        ok: false,
        message: `Criterion ${n}'s label has invisible formatting characters (like a zero-width space). Type the label again as plain text.`,
      };
    }
    const labelChars = countChars(label);
    if (labelChars > MAX_LABEL_CHARS) {
      return {
        ok: false,
        message: `Criterion ${n}'s label is ${formatNumber(labelChars)} characters; the limit is ${MAX_LABEL_CHARS}. Keep the label short and put the rest in the detail.`,
      };
    }
    if (detail === "") {
      return { ok: false, message: `Criterion ${n} needs a detail: what it means to you, in your own words.` };
    }
    const detailChars = countChars(detail);
    if (detailChars > MAX_DETAIL_CHARS) {
      return {
        ok: false,
        message: `Criterion ${n}'s detail is ${formatNumber(detailChars)} characters; the limit is ${MAX_DETAIL_CHARS}. Keep the part that matters most.`,
      };
    }

    const key = sameLabelKey(label);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      const earlierLabel = criteria[earlier - 1]?.label ?? label;
      return {
        ok: false,
        message: `Criteria ${earlier} and ${n} have the same label ("${earlierLabel}"). Give each one its own label.`,
      };
    }
    seen.set(key, n);
    criteria.push({ label, detail });
  }

  return { ok: true, criteria };
}

// Every invisible "format" character, including the allowed ones, for the duplicate check only.
const ALL_FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * What makes two labels "the same". Three steps:
 * 1. NFKC normalization: "é" typed as one character or as "e" + an accent becomes the same, and
 *    look-alike forms fold to the plain letter (fullwidth "Ｐ" → "P", the ligature "ﬁ" → "fi",
 *    a no-break space → a space).
 * 2. Invisible format characters (\p{Cf}: joiners, direction marks, tag characters) are removed,
 *    so "Pay floor" and "Pay floor" + a zero-width joiner match. Every run of blank space then
 *    becomes one space ("Pay  floor" → "Pay floor").
 * 3. Full Unicode case folding (see fullCaseFold).
 */
export function sameLabelKey(label: string): string {
  return fullCaseFold(
    label
      .normalize("NFKC")
      .replace(ALL_FORMAT_CHARACTERS, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * Unicode full case folding (what Python's str.casefold() does). JavaScript has no casefold(),
 * so it is built from lower → upper → lower:
 * - lower first turns capital sharp S "ẞ" into "ß", which upper then expands to "SS" → "ss";
 * - upper then lower folds "ß" → "ss" and Greek final "ς" → "Σ" → "σ".
 * Dotless "ı" is the one letter this gets wrong: it upper-cases to "I", which would merge it with
 * "i", a different Turkish letter. Case folding leaves "ı" alone, so it is kept out of the chain.
 * Checked against Python's casefold() for every assigned code point in Unicode 16: same result.
 */
function fullCaseFold(text: string): string {
  return text
    .split("ı")
    .map((part) => part.toLowerCase().toUpperCase().toLowerCase())
    .join("ı");
}

