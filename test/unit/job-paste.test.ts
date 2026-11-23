// Paste fallback (PRD 01 §2 story 3): job description text of 200–50,000 characters, with an
// optional title and company. Pure rules, no database.
import { describe, expect, it } from "vitest";
import { MAX_PASTE_CHARS, MIN_PASTE_CHARS, MAX_PASTE_FIELD_CHARS, parsePastedJob } from "../../src/domain/job-paste.js";

const JD = `Staff Engineer at a fictional company. ${"We build accessible software for libraries. ".repeat(6)}`;

function message(input: Parameters<typeof parsePastedJob>[0]): string {
  const result = parsePastedJob(input);
  if (result.ok) throw new Error("expected a rejection");
  return result.message;
}

describe("parsePastedJob", () => {
  it("uses the PRD's limits", () => {
    expect([MIN_PASTE_CHARS, MAX_PASTE_CHARS, MAX_PASTE_FIELD_CHARS]).toEqual([200, 50_000, 300]);
  });

  it("accepts text alone; title and company come back null", () => {
    expect(parsePastedJob({ text: JD })).toEqual({ ok: true, job: { text: JD, title: null, company: null } });
  });

  it("accepts and trims an optional title and company", () => {
    expect(parsePastedJob({ text: JD, title: "  Staff Engineer ", company: " Acme Libraries " })).toEqual({
      ok: true,
      job: { text: JD, title: "Staff Engineer", company: "Acme Libraries" },
    });
  });

  it("treats a blank title or company as not given", () => {
    expect(parsePastedJob({ text: JD, title: "   ", company: "" })).toMatchObject({
      ok: true,
      job: { title: null, company: null },
    });
  });

  it("keeps the text exactly as pasted", () => {
    const text = `\n  ${JD}\n\n`;
    expect(parsePastedJob({ text })).toMatchObject({ ok: true, job: { text } });
  });

  it("rejects text under 200 characters (blank space at the ends doesn't count)", () => {
    const short = "a".repeat(199);
    expect(message({ text: `   ${short}   ` })).toBe(
      "The job description is 199 characters; it needs at least 200. Paste the whole job description.",
    );
  });

  it("accepts exactly 200 and exactly 50,000 characters, counting an emoji as one", () => {
    expect(parsePastedJob({ text: "😀".repeat(200) }).ok).toBe(true);
    expect(parsePastedJob({ text: "a".repeat(50_000) }).ok).toBe(true);
  });

  it("rejects text over 50,000 characters", () => {
    expect(message({ text: "a".repeat(50_001) })).toBe(
      "The job description is 50,001 characters; the limit is 50,000. Paste only the job posting.",
    );
  });

  it("rejects a file's raw bytes", () => {
    expect(message({ text: `${JD}\u0000` })).toBe(
      "That looks like a file's raw contents, not text. Paste the job description as plain text.",
    );
  });

  it("rejects a title or company over 300 characters", () => {
    expect(message({ text: JD, title: "t".repeat(301) })).toBe("The title is 301 characters; the limit is 300.");
    expect(message({ text: JD, company: "c".repeat(301) })).toBe("The company is 301 characters; the limit is 300.");
  });

  it("rejects a title or company on several lines or with raw bytes", () => {
    expect(message({ text: JD, title: "Staff\nEngineer" })).toBe("The title must be one line of text.");
    expect(message({ text: JD, company: "Acme\u0007" })).toBe("The company must be one line of text.");
  });
});
