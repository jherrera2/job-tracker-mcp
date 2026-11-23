// Rules for the master résumé text (PRD 01 §2 story 1). Pure functions, no database, so they
// are unit-tested on their own (test/unit/master-resume.test.ts).
//
// The rules:
// - Text only (plain text or Markdown), 200–60,000 characters.
// - "Characters" means what a person counts: an emoji or an accented letter is ONE character.
//   JavaScript's `.length` counts UTF-16 units, where "😀".length is 2, so we count with countChars.
// - Blank space at the ends doesn't count toward the 200 minimum, but the text is stored exactly
//   as sent: later steps check evidence quotes against it word for word.
// - Control characters (NUL, ESC...) mean someone sent a file's raw bytes, not text.
// - So does a lone UTF-16 surrogate (half of an emoji's pair). Postgres would quietly store it
//   as U+FFFD, and the saved text would no longer match what was sent.
//
// Each parse function returns either { ok: true, ... } or { ok: false, message }, where the
// message is a short sentence shown to the user in the chat. (A small Result type, instead of
// throwing, so a rule failing is a normal return value and not an exception.)
import { z } from "zod";

export const MIN_RESUME_CHARS = 200;
export const MAX_RESUME_CHARS = 60_000;

/**
 * Number of characters as a person counts them (Unicode code points): the same number as
 * `[...text].length`, where a lone surrogate also counts as one.
 *
 * It walks the UTF-16 units instead of spreading the string, because spreading builds an array
 * with one entry per character: a multi-MB paste would allocate millions of entries just to be
 * told it is too long (Copilot, PR #5). This loop allocates nothing.
 */
export function countChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i = nextCharIndex(text, i)) count++;
  return count;
}

/**
 * Index where the character starting at `i` ends: i + 2 for a surrogate pair (an emoji such as
 * "😀" is two UTF-16 units), i + 1 for anything else, including a lone surrogate.
 */
export function nextCharIndex(text: string, i: number): number {
  const unit = text.charCodeAt(i);
  if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
    const next = text.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return i + 2;
  }
  return i + 1;
}

// At least one character a person can see: a letter, digit, symbol or punctuation mark, other than
// the ones Unicode calls letters or symbols but that print as blank space (Hangul fillers
// U+115F/U+1160/U+3164/U+FFA0 and the empty Braille pattern U+2800). Blank space, invisible format
// characters (zero-width space, joiners, direction marks...) and bare accents don't count.
// Moved here from criteria.ts (step 3) so prompts use the same rule (Copilot, PR #5).
const VISIBLE_CHAR = /(?![\u115F\u1160\u3164\uFFA0\u2800])[\p{L}\p{N}\p{S}\p{P}]/u;

/** True when `text` holds at least one visible character. Invisible characters inside real text are fine. */
export function hasVisibleChar(text: string): boolean {
  return VISIBLE_CHAR.test(text);
}

// Control characters other than tab (\t), line feed (\n), form feed (\f, the page break that
// copy-paste from a PDF often leaves) and carriage return (\r). Postgres can't even store \u0000.
// Also the C1 controls U+0080–U+009F: no keyboard types them; they appear when a Windows-1252 or
// binary file is decoded as Latin-1 (and U+009B starts a terminal escape sequence).
// eslint-disable-next-line no-control-regex -- matching control characters is the whole point here
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/;

/**
 * False when `text` holds control characters or a lone surrogate: a file's raw bytes or broken
 * text, not something a person typed. Shared with the criteria rules (src/domain/criteria.ts).
 */
export function isPlainText(text: string): boolean {
  // isWellFormed() is false when the string holds a lone surrogate (ES2024, Node 20+).
  return !CONTROL_CHARACTERS.test(text) && text.isWellFormed();
}

// en-US formatting puts the thousands comma in: 60000 -> "60,000".
export const formatNumber = (n: number): string => n.toLocaleString("en-US");

// The Zod schema for the résumé text. `superRefine` lets one function run the rules in order and
// stop at the first failure, so the user gets one sentence, not a list.
// No custom message for "not a string": the tool's published inputSchema already says `string`,
// so the MCP SDK rejects wrong types before this code is reached.
const MasterResumeTextSchema = z
  .string()
  .superRefine((text, ctx) => {
    if (!isPlainText(text)) {
      ctx.addIssue({
        code: "custom",
        message: "That looks like a file's raw contents, not text. Paste the résumé as plain text or Markdown.",
      });
      return;
    }
    const contentChars = countChars(text.trim());
    if (contentChars < MIN_RESUME_CHARS) {
      ctx.addIssue({
        code: "custom",
        message: `Your résumé is ${formatNumber(contentChars)} characters; it needs at least ${formatNumber(MIN_RESUME_CHARS)}. Paste the whole résumé.`,
      });
      return;
    }
    const totalChars = countChars(text);
    if (totalChars > MAX_RESUME_CHARS) {
      ctx.addIssue({
        code: "custom",
        message: `Your résumé is ${formatNumber(totalChars)} characters; the limit is ${formatNumber(MAX_RESUME_CHARS)}. Remove anything that isn't part of the résumé.`,
      });
    }
  });

// A version number: a whole number from 1 up to the largest Postgres `integer` (the column type),
// so a huge number gets this sentence instead of Postgres' "out of range" error.
// Optional, because "no version" means "the latest".
// The message on z.number() itself only matters for NaN (a number, but not a valid one).
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const VERSION_MESSAGE = "Version must be a whole number, 1 or higher.";
const ResumeVersionSchema = z
  .number({ error: VERSION_MESSAGE })
  .int({ error: VERSION_MESSAGE })
  .min(1, { error: VERSION_MESSAGE })
  .max(MAX_POSTGRES_INTEGER, { error: VERSION_MESSAGE })
  .optional();

export type ParseResult<T> = ({ ok: true } & T) | { ok: false; message: string };

/** Only the first issue's message: our own sentence, never Zod's wording or the input value. */
function firstMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

/** Checks the résumé text. On success the text comes back unchanged. */
export function parseMasterResumeText(input: string): ParseResult<{ text: string }> {
  const result = MasterResumeTextSchema.safeParse(input);
  return result.success ? { ok: true, text: result.data } : { ok: false, message: firstMessage(result.error) };
}

/** Checks an optional version number; `undefined` means "the latest". */
export function parseResumeVersion(input: number | undefined): ParseResult<{ version: number | undefined }> {
  const result = ResumeVersionSchema.safeParse(input);
  return result.success ? { ok: true, version: result.data } : { ok: false, message: firstMessage(result.error) };
}
