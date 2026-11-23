// Validation rules for the master résumé (PRD 01 §2 story 1): text only, 200–60,000 characters.
// These are pure functions, so no database is needed here; the tools are tested end to end in
// test/integration/master-resume-tools.test.ts.
import { describe, expect, it } from "vitest";
import {
  MAX_RESUME_CHARS,
  MIN_RESUME_CHARS,
  countChars,
  hasVisibleChar,
  isPlainText,
  parseMasterResumeText,
  parseResumeVersion,
} from "../../src/domain/master-resume.js";

// A realistic Markdown line, repeated to reach a given length exactly.
function textOfLength(length: number): string {
  const line = "- Led a team of 4 to ship **payments** v2.\n";
  return line.repeat(Math.ceil(length / line.length)).slice(0, length);
}

describe("limits", () => {
  it("are 200 and 60,000 characters", () => {
    expect(MIN_RESUME_CHARS).toBe(200);
    expect(MAX_RESUME_CHARS).toBe(60_000);
  });
});

describe("countChars", () => {
  it("counts each emoji or accented letter as one character, not two", () => {
    // "😀".length is 2 in JavaScript (two UTF-16 code units); a person counts it as 1.
    expect(countChars("😀")).toBe(1);
    expect(countChars("Résumé")).toBe(6);
    expect(countChars("")).toBe(0);
  });

  it("counts exactly what spreading the string counts, lone surrogates included", () => {
    for (const text of ["a😀b", "👩‍💻", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "x\ud83dy", "\ude00", "\ud83d", "\ud83d\ud83d\ude00", "e\u0301"]) {
      expect(countChars(text), JSON.stringify(text)).toBe([...text].length);
    }
  });

  // Copilot (PR #5): `[...text].length` built an array with one entry per character, so a
  // multi-MB paste allocated millions of entries just to be told it is too long. Spreading or
  // Array.from goes through String.prototype[Symbol.iterator]; make that throw during the call.
  it("counts 8 MB without building a per-character array (never iterates the string)", () => {
    const text = "😀a".repeat(3 * 1024 * 1024);
    expect(withoutStringIterator(() => countChars(text))).toBe(6 * 1024 * 1024);
  });
});

describe("hasVisibleChar", () => {
  it.each([
    ["a letter", "a"],
    ["a digit", "7"],
    ["an emoji", "😀"],
    ["punctuation", "?"],
    ["real text with invisible characters inside", "Be\u200B honest\u200D."],
  ])("is true for %s", (_label, text) => {
    expect(hasVisibleChar(text)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["blank space", " \n\t\u00A0\u3000"],
    ["zero-width characters", "\u200B\u200C\u200D\u2060\uFEFF"],
    ["direction marks and overrides", "\u200E\u200F\u202E\u2066"],
    ["Hangul fillers and blank Braille", "\u115F\u1160\u3164\uFFA0\u2800"],
    ["bare accents", "\u0301\u0308"],
    ["a soft hyphen", "\u00AD"],
  ])("is false for %s", (_label, text) => {
    expect(hasVisibleChar(text)).toBe(false);
  });
});

describe("parseMasterResumeText", () => {
  it("accepts Markdown at exactly 200 characters and returns the text unchanged", () => {
    const text = textOfLength(200);
    expect(parseMasterResumeText(text)).toEqual({ ok: true, text });
  });

  it("accepts exactly 60,000 characters", () => {
    const text = textOfLength(60_000);
    expect(parseMasterResumeText(text)).toEqual({ ok: true, text });
  });

  it("accepts plain text with tabs, Windows line breaks and form feeds (page breaks from PDF copy-paste)", () => {
    const text = `Jane Doe\r\nSenior Engineer\t2019–2024\f${"Built things that mattered. ".repeat(10)}`;
    expect(parseMasterResumeText(text)).toEqual({ ok: true, text });
  });

  it("keeps leading and trailing blank space (evidence quotes are checked word for word later)", () => {
    const text = `\n\n  ${textOfLength(250)}  \n`;
    expect(parseMasterResumeText(text)).toEqual({ ok: true, text });
  });

  it("rejects 199 characters with a sentence that gives the count and the minimum", () => {
    expect(parseMasterResumeText(textOfLength(199))).toEqual({
      ok: false,
      message: "Your résumé is 199 characters; it needs at least 200. Paste the whole résumé.",
    });
  });

  it("rejects 60,001 characters with a sentence that gives the count and the limit", () => {
    expect(parseMasterResumeText(textOfLength(60_001))).toEqual({
      ok: false,
      message: "Your résumé is 60,001 characters; the limit is 60,000. Remove anything that isn't part of the résumé.",
    });
  });

  it("does not count blank space at the ends toward the minimum", () => {
    const result = parseMasterResumeText(`${"a".repeat(150)}${" ".repeat(100)}`);
    expect(result).toEqual({
      ok: false,
      message: "Your résumé is 150 characters; it needs at least 200. Paste the whole résumé.",
    });
  });

  it("rejects blank text", () => {
    expect(parseMasterResumeText(" \n\t ".repeat(100))).toMatchObject({ ok: false });
  });

  it("counts characters, not UTF-16 units: 30,001 emoji (60,002 units) is under the limit", () => {
    const text = "😀".repeat(30_001);
    expect(text.length).toBe(60_002);
    expect(parseMasterResumeText(text)).toEqual({ ok: true, text });
  });

  it("counts characters, not UTF-16 units: 150 emoji (300 units) is under the minimum", () => {
    expect(parseMasterResumeText("😀".repeat(150))).toMatchObject({ ok: false });
  });

  it.each([
    ["a NUL byte", "\u0000"],
    ["a bell character", "\u0007"],
    ["an escape character", "\u001B"],
    ["a DEL character", "\u007F"],
    ["the first C1 control character (U+0080)", "\u0080"],
    ["a C1 next-line character (U+0085)", "\u0085"],
    ["a C1 escape sequence start (U+009B)", "\u009B"],
    ["the last C1 control character (U+009F)", "\u009F"],
  ])("rejects text containing %s (looks like a file, not text)", (_name, bad) => {
    const text = textOfLength(300) + bad + textOfLength(10);
    expect(parseMasterResumeText(text)).toEqual({
      ok: false,
      message: "That looks like a file's raw contents, not text. Paste the résumé as plain text or Markdown.",
    });
  });

  it.each([
    ["a lone high surrogate", "\uD800"],
    ["a lone low surrogate", "\uDFFF"],
  ])("rejects text containing %s (broken text that can't be stored word for word)", (_name, bad) => {
    // A lone surrogate is half of an emoji's UTF-16 pair. Postgres would silently store it as
    // U+FFFD (the "?" replacement character), so the saved text would no longer match what was sent.
    const text = textOfLength(300) + bad + textOfLength(10);
    expect(parseMasterResumeText(text)).toEqual({
      ok: false,
      message: "That looks like a file's raw contents, not text. Paste the résumé as plain text or Markdown.",
    });
  });
});

describe("parseResumeVersion", () => {
  it("treats a missing version as 'the latest'", () => {
    expect(parseResumeVersion(undefined)).toEqual({ ok: true, version: undefined });
  });

  it.each([1, 2, 999, 2_147_483_647])("accepts %d", (version) => {
    expect(parseResumeVersion(version)).toEqual({ ok: true, version });
  });

  // 2,147,483,648 is one past the largest value of a Postgres `integer` column.
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])("rejects %s", (version) => {
    expect(parseResumeVersion(version)).toEqual({
      ok: false,
      message: "Version must be a whole number, 1 or higher.",
    });
  });
});

describe("isPlainText", () => {
  it("accepts ordinary text, line breaks, tabs, form feeds, accents, emoji and U+00A0 (no-break space)", () => {
    expect(isPlainText("Résumé\r\n\tLine two\f😀\u00A0end")).toBe(true);
  });

  it.each([
    ["U+0000", "\u0000"],
    ["U+007F", "\u007F"],
    ["U+0080", "\u0080"],
    ["U+009F", "\u009F"],
    ["a lone surrogate", "\uD83D"],
  ])("rejects %s", (_name, bad) => {
    expect(isPlainText(`text ${bad} text`)).toBe(false);
  });
});

/** Runs `work` with string iteration (spread, Array.from, for...of) made to throw. */
function withoutStringIterator<T>(work: () => T): T {
  const original = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator);
  if (!original) throw new Error("String.prototype has no iterator");
  Object.defineProperty(String.prototype, Symbol.iterator, {
    ...original,
    value: () => {
      throw new Error("iterated the string");
    },
  });
  try {
    return work();
  } finally {
    Object.defineProperty(String.prototype, Symbol.iterator, original);
  }
}
