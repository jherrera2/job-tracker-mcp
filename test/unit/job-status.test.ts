import { describe, expect, it } from "vitest";
import { JOB_STATUSES } from "../../src/db/lookups.js";
import {
  ALLOWED_MOVES,
  canMove,
  checkStatusMove,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_STATUS_NOTE_CHARS,
  parseJobStatus,
  parseListPage,
  parseStatusNote,
  SKIP_NEEDS_NOTE,
  UNKNOWN_STATUS,
} from "../../src/domain/job-status.js";

// Every allowed move, written out flat so the test reads as a spec.
// skip   = passed on it BEFORE applying (may revisit or apply later), so it is not a dead end.
// closed = it ended AFTER applying.
const EXPECTED_MOVES = [
  "saved->go",
  "saved->skip",
  "saved->applied",
  "go->skip",
  "go->applied",
  "skip->go",
  "skip->applied",
  "applied->interviewing",
  "applied->closed",
  "interviewing->offer",
  "interviewing->closed",
  "offer->closed",
];

describe("job status moves (enforced by set_status in step 7)", () => {
  it("has an entry for every status", () => {
    expect(Object.keys(ALLOWED_MOVES).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it("allows exactly the listed moves, no more", () => {
    const actual = Object.entries(ALLOWED_MOVES).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`));
    expect(actual.sort()).toEqual([...EXPECTED_MOVES].sort());
  });

  it("canMove agrees with the list for every possible pair", () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        expect(canMove(from, to), `${from}->${to}`).toBe(EXPECTED_MOVES.includes(`${from}->${to}`));
      }
    }
  });

  it("never allows staying on the same status or going backwards after applying", () => {
    for (const status of JOB_STATUSES) expect(canMove(status, status)).toBe(false);
    expect(canMove("applied", "go")).toBe(false);
    expect(canMove("offer", "interviewing")).toBe(false);
    expect(canMove("closed", "saved")).toBe(false);
  });

  it("lets every status be reached from saved, and closed is the only dead end", () => {
    const reachable = new Set<string>(["saved"]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const from of JOB_STATUSES) {
        if (!reachable.has(from)) continue;
        for (const to of ALLOWED_MOVES[from]) {
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...JOB_STATUSES].sort());

    const deadEnds = JOB_STATUSES.filter((s) => ALLOWED_MOVES[s].length === 0);
    expect(deadEnds).toEqual(["closed"]);
  });

  it("reaches closed only from applied, interviewing or offer (closed means after applying)", () => {
    const into = JOB_STATUSES.filter((from) => canMove(from, "closed"));
    expect(into.sort()).toEqual(["applied", "interviewing", "offer"]);
  });

  it("does not make skip a dead end (you may revisit or apply later)", () => {
    expect(ALLOWED_MOVES.skip.length).toBeGreaterThan(0);
    expect(canMove("skip", "go")).toBe(true);
    expect(canMove("skip", "applied")).toBe(true);
  });
});

describe("parseJobStatus (set_status and list_jobs)", () => {
  it.each(JOB_STATUSES.map((s) => [s]))("accepts %s", (status) => {
    expect(parseJobStatus(status)).toEqual({ ok: true, status });
  });

  it("ignores blank space at the ends and letter case", () => {
    expect(parseJobStatus("  Applied ")).toEqual({ ok: true, status: "applied" });
    expect(parseJobStatus("SKIP")).toEqual({ ok: true, status: "skip" });
  });

  it.each([[""], ["   "], ["skipped"], ["Closed (after applying)"], ["rejected"], ["go!"], ["sav ed"]])(
    "refuses %j with a sentence that lists the statuses and does not repeat the input",
    (input) => {
      const result = parseJobStatus(input);
      expect(result).toEqual({ ok: false, message: UNKNOWN_STATUS });
    },
  );

  it("the unknown-status sentence names every status in order", () => {
    expect(UNKNOWN_STATUS).toContain(JOB_STATUSES.join(", "));
  });
});

describe("parseStatusNote", () => {
  it("absent, null, empty and blank all mean no note", () => {
    for (const input of [undefined, null, "", "   ", "\n\t ", "\u200B", "\u00A0"]) {
      expect(parseStatusNote(input), JSON.stringify(input)).toEqual({ ok: true, note: null });
    }
  });

  it("trims the ends and keeps line breaks inside", () => {
    expect(parseStatusNote("  Pay too low.\nOn-call every week.  ")).toEqual({
      ok: true,
      note: "Pay too low.\nOn-call every week.",
    });
  });

  it(`allows exactly ${MAX_STATUS_NOTE_CHARS} characters, counted as a person counts them`, () => {
    expect(parseStatusNote("😀".repeat(MAX_STATUS_NOTE_CHARS))).toEqual({ ok: true, note: "😀".repeat(MAX_STATUS_NOTE_CHARS) });
    // Blank space at the ends does not count toward the limit (it is trimmed away).
    expect(parseStatusNote(` ${"a".repeat(MAX_STATUS_NOTE_CHARS)} `).ok).toBe(true);
  });

  it(`refuses ${MAX_STATUS_NOTE_CHARS + 1} characters with the count and the limit`, () => {
    expect(parseStatusNote("a".repeat(MAX_STATUS_NOTE_CHARS + 1))).toEqual({
      ok: false,
      message: "The note is 501 characters; the limit is 500.",
    });
  });

  it.each([["\u0000"], ["a\u0007b"], ["x\u009By"], ["\uD800 lone surrogate"]])("refuses control characters / broken text %j", (input) => {
    expect(parseStatusNote(input)).toEqual({
      ok: false,
      message: "The note has characters that aren't text (control characters). Write it as plain text.",
    });
  });
});

describe("checkStatusMove", () => {
  it("allows every move in ALLOWED_MOVES (with a note for skip)", () => {
    for (const from of JOB_STATUSES) {
      for (const to of ALLOWED_MOVES[from]) {
        expect(checkStatusMove(from, to, to === "skip" ? "Not for me." : null), `${from}->${to}`).toEqual({ ok: true });
      }
    }
  });

  it("refuses skip without a note, from every status that may skip", () => {
    for (const from of JOB_STATUSES.filter((s) => canMove(s, "skip"))) {
      expect(checkStatusMove(from, "skip", null)).toEqual({ ok: false, message: SKIP_NEEDS_NOTE });
    }
  });

  it("the skip sentence asks for a reason and gives the limit", () => {
    expect(SKIP_NEEDS_NOTE).toMatch(/reason/);
    expect(SKIP_NEEDS_NOTE).toContain("1 to 500 characters");
  });

  it("refuses every move NOT in ALLOWED_MOVES, naming where the job can go instead", () => {
    expect(checkStatusMove("applied", "go", null)).toEqual({
      ok: false,
      message: 'A job can\'t move from "applied" to "go". From "applied" it can move to "interviewing" or "closed".',
    });
    expect(checkStatusMove("saved", "interviewing", null)).toEqual({
      ok: false,
      message: 'A job can\'t move from "saved" to "interviewing". From "saved" it can move to "go", "skip" or "applied".',
    });
    expect(checkStatusMove("offer", "interviewing", null)).toEqual({
      ok: false,
      message: 'A job can\'t move from "offer" to "interviewing". From "offer" it can move to "closed".',
    });
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        if (canMove(from, to)) continue;
        expect(checkStatusMove(from, to, "a note").ok, `${from}->${to}`).toBe(false);
      }
    }
  });

  it("says the job is already there when the status does not change", () => {
    expect(checkStatusMove("go", "go", null)).toEqual({ ok: false, message: 'The job is already "go".' });
    expect(checkStatusMove("skip", "skip", "again")).toEqual({ ok: false, message: 'The job is already "skip".' });
  });

  it("says a closed job can't change any more", () => {
    for (const to of JOB_STATUSES.filter((s) => s !== "closed")) {
      expect(checkStatusMove("closed", to, "note")).toEqual({
        ok: false,
        message: "This job is closed, so its status can't change any more.",
      });
    }
  });

  it("a not-allowed move is refused for the move, not for a missing note (skip from applied)", () => {
    expect(checkStatusMove("applied", "skip", null)).toEqual({
      ok: false,
      message: 'A job can\'t move from "applied" to "skip". From "applied" it can move to "interviewing" or "closed".',
    });
  });
});

describe("parseListPage (list_jobs)", () => {
  it(`defaults to ${DEFAULT_LIST_LIMIT} jobs from the start`, () => {
    expect(parseListPage({})).toEqual({ ok: true, limit: DEFAULT_LIST_LIMIT, offset: 0 });
    expect(parseListPage({ limit: null, offset: null })).toEqual({ ok: true, limit: DEFAULT_LIST_LIMIT, offset: 0 });
  });

  it(`accepts limit 1 to ${MAX_LIST_LIMIT} and any whole offset from 0`, () => {
    expect(parseListPage({ limit: 1, offset: 0 })).toEqual({ ok: true, limit: 1, offset: 0 });
    expect(parseListPage({ limit: MAX_LIST_LIMIT, offset: 250 })).toEqual({ ok: true, limit: MAX_LIST_LIMIT, offset: 250 });
  });

  it.each([[0], [-1], [MAX_LIST_LIMIT + 1], [2.5], [Number.NaN], [Number.POSITIVE_INFINITY]])("refuses limit %s", (limit) => {
    expect(parseListPage({ limit })).toEqual({ ok: false, message: `limit must be a whole number from 1 to ${MAX_LIST_LIMIT}.` });
  });

  it.each([[-1], [1.5], [Number.NaN], [2 ** 53]])("refuses offset %s", (offset) => {
    expect(parseListPage({ offset })).toEqual({ ok: false, message: "offset must be a whole number, 0 or higher." });
  });
});
