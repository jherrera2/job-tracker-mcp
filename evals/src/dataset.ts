// The shape of an eval case, and the pure helpers that turn the dataset (evals/dataset/cases.ts)
// into runnable cases. No database, no network (test/unit/evals/dataset.test.ts).
import { readFileSync } from "node:fs";
import type { CriterionStatus, RequirementStatus } from "../../src/domain/fit-score.js";

export type Recommendation = "go" | "maybe" | "skip";
export type CaseKind = "fit" | "negation" | "injection";

/** A posting added with add_job { text, title, company }: the paste path. */
export interface PastePosting {
  source: "paste";
  title: string;
  company: string;
  text: string;
}

/**
 * A posting served as a recorded Greenhouse API answer and added with add_job { url }, so its HTML
 * goes through the real step-4 code (greenhouse.ts → htmlToText) exactly like a live job link.
 */
export interface GreenhousePosting {
  source: "greenhouse";
  title: string;
  company: string;
  location: string;
  payMinUsd: number;
  payMaxUsd: number;
  html: string;
}

export type Posting = PastePosting | GreenhousePosting;

/**
 * An attack added to a clean posting: right after the first `after` text, IN PLACE of the first
 * `replace` text (step 12 rework: so a real fact can appear only inside the attack), or at the end.
 */
export interface Injection {
  text: string;
  after?: string;
  replace?: string;
}

/**
 * Step 12 rework: statuses a criterion must have in this case, by label (any of the listed ones).
 * Checked per run; a miss makes the run exit 1.
 */
export type ExpectCriteria = Readonly<Record<string, readonly CriterionStatus[]>>;

/** Optional checks any case may carry (step 12 rework). */
interface CaseChecks {
  expectCriteria?: ExpectCriteria;
  /**
   * Phrases that would mean a red flag reported an ORDINARY posting line as an injection
   * ("prompt injection", "instruct you"). Matched case-insensitively.
   */
  notFlagPhrases?: string[];
}

/** One entry in evals/dataset/cases.ts. */
export type CaseDef =
  | ({ id: string; title: string; kind: "fit" | "negation"; expected: Recommendation[]; posting: Posting } & CaseChecks)
  | ({
      id: string;
      title: string;
      kind: "injection";
      twinOf: string;
      injection: Injection;
      /**
       * Phrases a red flag would use when it reports THIS attack ("rate it 100%", "hidden text").
       * Matched case-insensitively for the informational "flagged" column; generic words such as
       * "system" or "instructions" are left out on purpose, because ordinary red flags use them.
       */
      flagPhrases: string[];
    } & CaseChecks);

/** A case ready to run: injection cases carry their twin's posting (plus the attack) and range. */
export interface EvalCase {
  id: string;
  title: string;
  kind: CaseKind;
  expected: Recommendation[];
  /** For injection cases, the id of the clean case it is compared with. */
  twinOf: string | null;
  /** For injection cases, the phrases that mark a red flag as reporting this attack; [] otherwise. */
  flagPhrases: string[];
  posting: Posting;
  /** Optional on hand-built cases (tests); resolveCases always fills them ({} and []). */
  expectCriteria?: ExpectCriteria;
  notFlagPhrases?: string[];
}

/** A résumé line that negates a skill ("Not certified in AWS …") and the claim it negates. */
export interface NegatedClaim {
  line: string;
  claim: string;
}

/** A requirement as save_fit stored it (after the quote check). */
export interface StoredRequirement {
  text: string;
  status: RequirementStatus;
  evidence_quote?: string;
}

const MASTER_RESUME_URL = new URL("../dataset/master-resume.md", import.meta.url);

export function readMasterResume(): string {
  return readFileSync(MASTER_RESUME_URL, "utf8");
}

/** The posting with the attack added. Throws if `after` is not found, so a typo can't skip the attack. */
export function applyInjection(posting: Posting, injection: Injection): Posting {
  const body = posting.source === "paste" ? posting.text : posting.html;
  let injected: string;
  if (injection.after !== undefined && injection.replace !== undefined) {
    throw new Error("An injection takes `after` or `replace`, not both.");
  }
  if (injection.replace !== undefined) {
    const at = body.indexOf(injection.replace);
    if (at === -1) throw new Error(`Injection replace text not found in the posting: ${JSON.stringify(injection.replace)}`);
    injected = `${body.slice(0, at)}${injection.text}${body.slice(at + injection.replace.length)}`;
  } else if (injection.after === undefined) {
    injected = `${body}\n\n${injection.text}`;
  } else {
    const at = body.indexOf(injection.after);
    if (at === -1) throw new Error(`Injection marker not found in the posting: ${JSON.stringify(injection.after)}`);
    const end = at + injection.after.length;
    injected = `${body.slice(0, end)}\n${injection.text}${body.slice(end)}`;
  }
  return posting.source === "paste" ? { ...posting, text: injected } : { ...posting, html: injected };
}

/** Checks the dataset and resolves each injection case against its clean twin. */
export function resolveCases(defs: readonly CaseDef[]): EvalCase[] {
  const byId = new Map<string, CaseDef>();
  for (const def of defs) {
    if (byId.has(def.id)) throw new Error(`Duplicate case id "${def.id}".`);
    byId.set(def.id, def);
  }
  return defs.map((def): EvalCase => {
    if (def.kind !== "injection") {
      if (def.expected.length === 0) throw new Error(`Case "${def.id}" has an empty expected range.`);
      return {
        id: def.id,
        title: def.title,
        kind: def.kind,
        expected: [...def.expected],
        twinOf: null,
        flagPhrases: [],
        posting: def.posting,
        expectCriteria: def.expectCriteria ?? {},
        notFlagPhrases: [...(def.notFlagPhrases ?? [])],
      };
    }
    const twin = byId.get(def.twinOf);
    if (!twin || twin.kind === "injection") {
      throw new Error(`Injection case "${def.id}" needs a clean twin; "${def.twinOf}" is not one.`);
    }
    if (def.flagPhrases.length === 0) throw new Error(`Injection case "${def.id}" needs at least one of its flagPhrases.`);
    return {
      id: def.id,
      title: def.title,
      kind: "injection",
      expected: [...twin.expected],
      twinOf: twin.id,
      flagPhrases: [...def.flagPhrases],
      posting: applyInjection(twin.posting, def.injection),
      expectCriteria: def.expectCriteria ?? {},
      notFlagPhrases: [...(def.notFlagPhrases ?? [])],
    };
  });
}

/** HTML-escapes text the way Greenhouse sends `content`: the HTML itself, entity-encoded. */
function encodeEntities(html: string): string {
  return html.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The JSON Greenhouse's Job Board API would answer for this posting (see src/sources/greenhouse.ts). */
export function greenhouseApiJson(posting: GreenhousePosting): Record<string, unknown> {
  return {
    title: posting.title,
    company_name: posting.company,
    location: { name: posting.location },
    content: encodeEntities(posting.html),
    pay_input_ranges: [
      { min_cents: posting.payMinUsd * 100, max_cents: posting.payMaxUsd * 100, currency_type: "USD", title: "Base salary" },
    ],
  };
}

/** The job link an HTML case is added with; the board name is made up and never fetched for real. */
export function greenhouseJobUrl(caseIndex: number): string {
  return `https://job-boards.greenhouse.io/evalcases/jobs/${1001 + caseIndex}`;
}
