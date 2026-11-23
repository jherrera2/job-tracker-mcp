// The fit-check answer the user's chat model sends to save_fit (PRD 01 §5): its shape and limits,
// checked with Zod, and the rule that its criteria use the saved labels. Pure code, no database
// (test/unit/fit-result.test.ts).
//
// The shape is enforced HERE, whatever the editable prompt says (PRD §2.6). On failure the answer
// is refused with ONE sentence naming the item and field ("Requirement 2: status must be …"), so
// the chat model can fix it and send it again (this replaces the original "one retry").
//
// The rules:
// - requirements: 1–60; each { text, status: met | partial | missing, evidence_quote? }.
//   met / partial NEED a non-blank evidence_quote; on missing a quote is dropped (no evidence).
//   evidence_quote: null counts as no quote.
//   Step 11 (employer view): a "partial" requirement may also carry make_explicit (a short sentence,
//   ≤ 300 characters, naming a fact already in the master résumé that, written plainly, would make
//   it "met") WITH make_explicit_quote (that fact, copied word for word; ≤ 1,000 characters, checked
//   by the quote check like evidence_quote). Both or neither: one without the other is refused.
//   null or blank counts as not given. On met / missing both are dropped (nothing to make explicit).
// - criteria: 0–5 (one per saved criterion); each { label, status: met | unclear | not_met, reason }.
// - red_flags: 0–20 short texts. recommendation: go | maybe | skip. summary: one sentence.
// - Text: no control characters (isPlainText), at least one visible character, trimmed, and at most
//   N characters counted as a person counts them (limits below).
// - Unknown fields are DROPPED at every level, so a score the model sends ("jd_match_pct": 100)
//   is never stored or read; the scores are computed by code (src/domain/fit-score.ts).
// - The answer may arrive as an object or as a JSON string (some chat apps stringify it).
// - Too-long lists are refused by their length BEFORE any item is read, so a huge list costs nothing.
import { z } from "zod";
import { MAX_CRITERIA, sameLabelKey } from "./criteria.js";
import type { CriterionStatus, RequirementStatus } from "./fit-score.js";
import { countChars, formatNumber, hasVisibleChar, isPlainText, type ParseResult } from "./master-resume.js";
import { RECOMMENDATIONS, type Recommendation } from "../db/lookups.js";

export const REQUIREMENT_STATUSES = ["met", "partial", "missing"] as const satisfies readonly RequirementStatus[];
export const CRITERION_STATUSES = ["met", "unclear", "not_met"] as const satisfies readonly CriterionStatus[];

export const MAX_REQUIREMENTS = 60;
export const MAX_REQUIREMENT_TEXT_CHARS = 500;
export const MAX_EVIDENCE_QUOTE_CHARS = 1_000;
export const MAX_MAKE_EXPLICIT_CHARS = 300;
export const MAX_CRITERION_LABEL_CHARS = 200;
export const MAX_REASON_CHARS = 500;
export const MAX_RED_FLAGS = 20;
export const MAX_RED_FLAG_CHARS = 300;
export const MAX_SUMMARY_CHARS = 500;
/** A JSON-string answer longer than this can't be valid under the limits above. */
export const MAX_RESULT_JSON_CHARS = 200_000;

export interface FitRequirement {
  text: string;
  status: RequirementStatus;
  /** Present for met / partial only. */
  evidence_quote?: string;
  /**
   * Partial only (step 11): a short sentence naming a fact from the master résumé that, written
   * plainly, would make this requirement "met". Always together with make_explicit_quote.
   */
  make_explicit?: string;
  /** Partial only: the fact make_explicit names, copied word for word from the master résumé. */
  make_explicit_quote?: string;
}

export interface FitCriterion {
  label: string;
  status: CriterionStatus;
  reason: string;
}

export interface FitResult {
  requirements: FitRequirement[];
  criteria: FitCriterion[];
  red_flags: string[];
  recommendation: Recommendation;
  summary: string;
}

// Messages are templates: "{name}" becomes the field's human name from its path (see nameOf),
// e.g. "summary", "Requirement 2: status" or "Red flag 3".
const NAME = "{name}";

const quoted = (words: readonly string[]) =>
  words.map((w) => `"${w}"`).join(", ").replace(/, ([^,]*)$/, " or $1");

/** A required text field: plain text, not blank, at most `max` characters; comes back trimmed. */
function textField(max: number, onMissing: string, onEmpty: string, onTooLong: string) {
  return z
    .string({ error: (issue) => (issue.input === undefined ? `${NAME} is missing. ${onMissing}` : `${NAME} must be text.`) })
    .superRefine((value, ctx) => {
      if (!isPlainText(value)) {
        ctx.addIssue({ code: "custom", message: `${NAME} has characters that aren't text (control characters). Write it as plain text.` });
        return;
      }
      if (!hasVisibleChar(value)) {
        ctx.addIssue({ code: "custom", message: `${NAME} is empty. ${onEmpty}` });
        return;
      }
      const chars = countChars(value.trim());
      if (chars > max) {
        ctx.addIssue({
          code: "custom",
          message: `${NAME} is ${formatNumber(chars)} characters; the limit is ${formatNumber(max)}. ${onTooLong}`,
        });
      }
    })
    .transform((value) => value.trim());
}

function enumField<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, {
    error: (issue) =>
      issue.input === undefined ? `${NAME} is missing. Send ${quoted(values)}.` : `${NAME} must be ${quoted(values)}.`,
  });
}

/** A list: "{name} must be a list" for anything else. Its length was already checked (checkListLengths). */
function listField<T extends z.ZodType>(item: T, onMissing: string) {
  return z.array(item, {
    error: (issue) => (issue.input === undefined ? `${NAME} is missing. ${onMissing}` : `${NAME} must be a list.`),
  });
}

function objectOf<T extends z.ZodRawShape>(shape: T, fields: string) {
  return z.object(shape, { error: () => `${NAME} must be an object with ${fields}.` });
}

/**
 * An optional plain-text field, capped at `max` characters (counted as a person counts them).
 * null is accepted and means the same as leaving it out: models often send null for "none"
 * (reviewer M1, PR #6). Whether it may be blank depends on the status, so that rule sits on the
 * requirement below.
 */
function optionalText(max: number, onControl: string, onTooLong: string) {
  return z
    .string({ error: () => `${NAME} must be text.` })
    .superRefine((value, ctx) => {
      if (!isPlainText(value)) {
        ctx.addIssue({ code: "custom", message: `${NAME} has characters that aren't text (control characters). ${onControl}` });
        return;
      }
      const chars = countChars(value.trim());
      if (chars > max) {
        ctx.addIssue({
          code: "custom",
          message: `${NAME} is ${formatNumber(chars)} characters; the limit is ${formatNumber(max)}. ${onTooLong}`,
        });
      }
    })
    .nullable()
    .optional();
}

// The evidence quote: optional, plain text, capped.
const EvidenceQuote = optionalText(MAX_EVIDENCE_QUOTE_CHARS, "Copy it from the résumé as plain text.", "Quote a shorter passage.");
// Step 11: the make-explicit suggestion and the résumé passage it rests on.
const MakeExplicit = optionalText(MAX_MAKE_EXPLICIT_CHARS, "Write it as plain text.", "Keep it to one short sentence.");
const MakeExplicitQuote = optionalText(MAX_EVIDENCE_QUOTE_CHARS, "Copy it from the résumé as plain text.", "Quote a shorter passage.");

/** A value that counts as given: text with at least one visible character. */
const isGiven = (value: string | null | undefined): value is string => typeof value === "string" && hasVisibleChar(value);

const Requirement = objectOf(
  {
    text: textField(MAX_REQUIREMENT_TEXT_CHARS, "Give the requirement in the posting's terms.", "Write the requirement in the posting's terms.", "Keep it short."),
    status: enumField(REQUIREMENT_STATUSES),
    evidence_quote: EvidenceQuote,
    make_explicit: MakeExplicit,
    make_explicit_quote: MakeExplicitQuote,
  },
  "text and status",
)
  .superRefine((requirement, ctx) => {
    if (requirement.status !== "missing" && !isGiven(requirement.evidence_quote)) {
      ctx.addIssue({
        code: "custom",
        message: `${NAME} is "${requirement.status}", so it needs an evidence_quote copied word for word from the master résumé. If there is none, mark it "missing".`,
      });
      return;
    }
    if (requirement.status !== "partial") return; // a suggestion on met / missing is dropped below
    const hasSuggestion = isGiven(requirement.make_explicit);
    const hasQuote = isGiven(requirement.make_explicit_quote);
    if (hasSuggestion && !hasQuote) {
      ctx.addIssue({
        code: "custom",
        message: `${NAME} has a make_explicit suggestion, so it needs a make_explicit_quote copied word for word from the master résumé. If the résumé has no such fact, leave make_explicit out.`,
      });
    } else if (hasQuote && !hasSuggestion) {
      ctx.addIssue({
        code: "custom",
        message: `${NAME} has a make_explicit_quote but no make_explicit. Send both, or leave both out.`,
      });
    }
  })
  .transform((requirement): FitRequirement => {
    if (requirement.status === "missing" || !isGiven(requirement.evidence_quote)) {
      return { text: requirement.text, status: requirement.status };
    }
    const kept: FitRequirement = { text: requirement.text, status: requirement.status, evidence_quote: requirement.evidence_quote.trim() };
    if (requirement.status === "partial" && isGiven(requirement.make_explicit) && isGiven(requirement.make_explicit_quote)) {
      kept.make_explicit = requirement.make_explicit.trim();
      kept.make_explicit_quote = requirement.make_explicit_quote.trim();
    }
    return kept;
  });

const Criterion = objectOf(
  {
    label: textField(MAX_CRITERION_LABEL_CHARS, "Use the criterion's label exactly as given.", "Use the criterion's label exactly as given.", "Use the saved label."),
    status: enumField(CRITERION_STATUSES),
    reason: textField(MAX_REASON_CHARS, "Give one sentence.", "Give one sentence.", "Keep it to one sentence."),
  },
  "label, status and reason",
);

const RedFlag = textField(MAX_RED_FLAG_CHARS, "", "Leave empty flags out.", "Keep it short.");

const FitResultSchema = z.object({
  requirements: listField(Requirement, "Send it as a list of the posting's requirements.").min(1, {
    error: `${NAME} is empty. List the requirements the posting states (at least one).`,
  }),
  criteria: listField(Criterion, "Send it as a list (empty when no criteria are saved)."),
  red_flags: listField(RedFlag, "Send it as a list (empty when there are none)."),
  recommendation: enumField(RECOMMENDATIONS),
  summary: textField(MAX_SUMMARY_CHARS, "Send one sentence.", "Send one sentence.", "Shorten it."),
});

const LIST_ITEM_NAMES: Record<string, string> = {
  requirements: "Requirement",
  criteria: "Criterion",
  red_flags: "Red flag",
};

/** The human name of the field at `path`: "summary", "Requirement 2", "Requirement 2: status". */
function nameOf(path: readonly PropertyKey[]): string {
  const [list, index, field] = path;
  const itemName = typeof list === "string" ? LIST_ITEM_NAMES[list] : undefined;
  if (itemName === undefined || typeof index !== "number") return String(list ?? "The result");
  const item = `${itemName} ${index + 1}`;
  return field === undefined ? item : `${item}: ${String(field)}`;
}

const LIST_LIMITS: { key: keyof FitResult; max: number; message: (n: number) => string }[] = [
  {
    key: "requirements",
    max: MAX_REQUIREMENTS,
    message: (n) =>
      `There are ${formatNumber(n)} requirements; the limit is ${MAX_REQUIREMENTS}. Merge small ones and keep the ones that matter.`,
  },
  {
    key: "criteria",
    max: MAX_CRITERIA,
    message: (n) => `There are ${formatNumber(n)} criteria results; the limit is ${MAX_CRITERIA}, one per saved criterion.`,
  },
  {
    key: "red_flags",
    max: MAX_RED_FLAGS,
    message: (n) => `There are ${formatNumber(n)} red flags; the limit is ${MAX_RED_FLAGS}. Keep the ones that matter.`,
  },
];

const NOT_AN_OBJECT =
  "The result must be a JSON object with requirements, criteria, red_flags, recommendation and summary.";

/** Checks the chat model's answer. On success, the cleaned answer (trimmed, unknown fields dropped). */
export function parseFitResult(input: unknown): ParseResult<{ result: FitResult }> {
  let value = input;
  if (typeof value === "string") {
    if (value.length > MAX_RESULT_JSON_CHARS) {
      return {
        ok: false,
        message: `The result is ${formatNumber(value.length)} characters of JSON; the limit is ${formatNumber(MAX_RESULT_JSON_CHARS)}.`,
      };
    }
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, message: "The result is not valid JSON. Send the JSON object itself, with no text before or after it." };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, message: NOT_AN_OBJECT };

  // Lengths first, before Zod reads any item.
  const record = value as Record<string, unknown>;
  for (const limit of LIST_LIMITS) {
    const list = record[limit.key];
    if (Array.isArray(list) && list.length > limit.max) return { ok: false, message: limit.message(list.length) };
  }

  const parsed = FitResultSchema.safeParse(value);
  if (parsed.success) return { ok: true, result: parsed.data };
  const issue = parsed.error.issues[0];
  if (!issue) return { ok: false, message: NOT_AN_OBJECT };
  return { ok: false, message: issue.message.replaceAll(NAME, nameOf(issue.path)) };
}

/**
 * Checks that the answer has exactly one result per saved criterion, matching labels the way
 * set_criteria compares them (sameLabelKey: case, spacing, fullwidth letters…). On success the
 * results come back in the saved order, carrying the SAVED label, so every stored fit check names
 * a criterion the same way.
 */
export function matchCriteriaLabels(
  results: readonly FitCriterion[],
  savedLabels: readonly string[],
): ParseResult<{ criteria: FitCriterion[] }> {
  if (savedLabels.length === 0) {
    return results.length === 0
      ? { ok: true, criteria: [] }
      : { ok: false, message: "No criteria are saved, so criteria must be an empty list." };
  }

  const positionByKey = new Map(savedLabels.map((label, i) => [sameLabelKey(label), i]));
  const byPosition = new Map<number, FitCriterion>();
  for (const result of results) {
    const position = positionByKey.get(sameLabelKey(result.label));
    if (position === undefined) {
      return {
        ok: false,
        message: `criteria has "${result.label}", which is not a saved criterion. Use the saved labels exactly: ${savedLabels.map((l) => `"${l}"`).join(", ")}.`,
      };
    }
    if (byPosition.has(position)) {
      return { ok: false, message: `criteria has "${result.label}" twice. Give one result for each saved criterion.` };
    }
    byPosition.set(position, result);
  }

  const criteria: FitCriterion[] = [];
  for (const [position, label] of savedLabels.entries()) {
    const result = byPosition.get(position);
    if (!result) {
      return { ok: false, message: `criteria has no result for "${label}". Give one result for each saved criterion.` };
    }
    criteria.push({ label, status: result.status, reason: result.reason });
  }
  return { ok: true, criteria };
}
