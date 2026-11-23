// Command-line options for `npm run evals -- …` and the hard caps. Pure (test/unit/evals/args.test.ts).
//
//   --dry-run                 use recorded answers (evals/recorded/); no API call, no key needed
//   --yes                     really call the API (without it, the plan is printed and nothing is sent)
//   --model <id>              default claude-sonnet-5-5; must be in the price table (cost.ts)
//   --max-output-tokens <n>   max_tokens per call (includes thinking), default 8000, at most 16000
//   --max-usd <n>             refuse if the WORST-CASE cost is above this, default 5, at most 25
//   --effort <level>          low | medium | high | xhigh | max; default: the model's own default
//   --cases <id,id>           run only these cases
//   --out <dir>               where results go, default evals/results
//   --repeats <n>             run every case n times (1–5, default 1); injection pairs then compare
//                             the MEDIAN of each side. The cost scales with n.
import { fileURLToPath } from "node:url";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface Options {
  dryRun: boolean;
  yes: boolean;
  model: string;
  maxOutputTokens: number;
  maxUsd: number;
  effort: Effort | null;
  caseIds: string[] | null;
  outDir: string;
  repeats: number;
}

export const DEFAULTS = {
  model: "claude-sonnet-5-5",
  maxOutputTokens: 8_000,
  maxUsd: 5,
  outDir: fileURLToPath(new URL("../results/", import.meta.url)),
} as const;

/** Hard caps no flag can raise. */
export const LIMITS = {
  /** Case RUNS per run: cases × --repeats. */
  maxCases: 40,
  maxOutputTokens: 16_000,
  maxUsd: 25,
  /** Model calls per case: the first answer + one fix after a save_fit error ("fix and resend"). */
  maxAttempts: 2,
  maxRepeats: 5,
  /** Tool calls run from one model reply; a reply with more ends the case (no second call). */
  maxToolCallsPerReply: 3,
  /** Each tool result sent back to the model is cut to this many characters. */
  maxToolResultChars: 2_000,
} as const;

type Parsed = { ok: true; options: Options } | { ok: false; message: string };

const FLAGS = new Set(["--dry-run", "--yes"]);
const VALUED = new Set(["--model", "--max-output-tokens", "--max-usd", "--effort", "--cases", "--out", "--repeats"]);

export function parseArgs(argv: readonly string[]): Parsed {
  const options: Options = {
    dryRun: false,
    yes: false,
    model: DEFAULTS.model,
    maxOutputTokens: DEFAULTS.maxOutputTokens,
    maxUsd: DEFAULTS.maxUsd,
    effort: null,
    caseIds: null,
    outDir: DEFAULTS.outDir,
    repeats: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (FLAGS.has(name) && eq === -1) {
      if (name === "--dry-run") options.dryRun = true;
      else options.yes = true;
      continue;
    }
    if (!VALUED.has(name)) return { ok: false, message: `Unknown option "${name}".` };

    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "" || value.startsWith("--")) {
      return { ok: false, message: `${name} needs a value.` };
    }
    const problem = applyValue(options, name, value);
    if (problem) return { ok: false, message: problem };
  }
  return { ok: true, options };
}

/** Sets one valued option; returns an error sentence, or null. */
function applyValue(options: Options, name: string, value: string): string | null {
  switch (name) {
    case "--model":
      options.model = value;
      return null;
    case "--max-output-tokens": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxOutputTokens) {
        return `--max-output-tokens must be a whole number from 1 to ${LIMITS.maxOutputTokens}.`;
      }
      options.maxOutputTokens = n;
      return null;
    }
    case "--max-usd": {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > LIMITS.maxUsd) return `--max-usd must be above 0 and at most ${LIMITS.maxUsd}.`;
      options.maxUsd = n;
      return null;
    }
    case "--effort":
      if (!EFFORTS.includes(value as Effort)) return `--effort must be one of: ${EFFORTS.join(", ")}.`;
      options.effort = value as Effort;
      return null;
    case "--repeats": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxRepeats) return `--repeats must be a whole number from 1 to ${LIMITS.maxRepeats}.`;
      options.repeats = n;
      return null;
    }
    case "--cases":
      options.caseIds = value.split(",").map((id) => id.trim()).filter((id) => id !== "");
      return null;
    default: // "--out"
      options.outDir = value;
      return null;
  }
}
