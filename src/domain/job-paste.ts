// Paste fallback for adding a job (PRD 01 §2 story 3): the job description as text, with an
// optional title and company. Pure rules, no database (test/unit/job-paste.test.ts).
//
// The rules:
// - Text: 200–50,000 characters, counted as a person counts them (an emoji is one), with blank
//   space at the ends not counting toward the minimum, like the master résumé. Stored as sent.
// - Raw file bytes or broken text are rejected with the résumé's rule (isPlainText).
// - Title and company are optional; trimmed; one line; at most 300 characters. A blank one counts
//   as not given (an AI client may send "" for a field it has no value for).
// - The text is untrusted job-posting data; nothing here interprets it.
import { z } from "zod";
import { countChars, formatNumber, isPlainText, type ParseResult } from "./master-resume.js";

export const MIN_PASTE_CHARS = 200;
export const MAX_PASTE_CHARS = 50_000;
export const MAX_PASTE_FIELD_CHARS = 300;

export interface PastedJobInput {
  text: string;
  title?: string | undefined;
  company?: string | undefined;
}

export interface PastedJob {
  text: string;
  title: string | null;
  company: string | null;
}

const PastedText = z.string().superRefine((text, ctx) => {
  if (!isPlainText(text)) {
    ctx.addIssue({
      code: "custom",
      message: "That looks like a file's raw contents, not text. Paste the job description as plain text.",
    });
    return;
  }
  const contentChars = countChars(text.trim());
  if (contentChars < MIN_PASTE_CHARS) {
    ctx.addIssue({
      code: "custom",
      message: `The job description is ${formatNumber(contentChars)} characters; it needs at least ${formatNumber(MIN_PASTE_CHARS)}. Paste the whole job description.`,
    });
    return;
  }
  const totalChars = countChars(text);
  if (totalChars > MAX_PASTE_CHARS) {
    ctx.addIssue({
      code: "custom",
      message: `The job description is ${formatNumber(totalChars)} characters; the limit is ${formatNumber(MAX_PASTE_CHARS)}. Paste only the job posting.`,
    });
  }
});

const LINE_BREAK_OR_TAB = /[\n\r\t\f\v\u0085\p{Zl}\p{Zp}]/u;

/** An optional one-line field ("title", "company"): trimmed, blank → null. */
const optionalLine = (name: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim() ?? "";
      if (trimmed === "") return null;
      if (!isPlainText(trimmed) || LINE_BREAK_OR_TAB.test(trimmed)) {
        ctx.addIssue({ code: "custom", message: `The ${name} must be one line of text.` });
        return z.NEVER;
      }
      const chars = countChars(trimmed);
      if (chars > MAX_PASTE_FIELD_CHARS) {
        ctx.addIssue({
          code: "custom",
          message: `The ${name} is ${formatNumber(chars)} characters; the limit is ${formatNumber(MAX_PASTE_FIELD_CHARS)}.`,
        });
        return z.NEVER;
      }
      return trimmed;
    });

const PastedJobSchema = z.object({ text: PastedText, title: optionalLine("title"), company: optionalLine("company") });

/** Checks a pasted job. On success the text comes back unchanged and the fields trimmed (or null). */
export function parsePastedJob(input: PastedJobInput): ParseResult<{ job: PastedJob }> {
  const result = PastedJobSchema.safeParse(input);
  if (!result.success) return { ok: false, message: result.error.issues[0]?.message ?? "Invalid input." };
  return { ok: true, job: { text: result.data.text, title: result.data.title, company: result.data.company } };
}
