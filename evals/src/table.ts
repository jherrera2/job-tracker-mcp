// Renders a run as Markdown: a summary against the PRD's targets, one row per case, and the
// injection pairs. Pure (test/unit/evals/table.test.ts). The output goes in evals/results/ and the README.
import type { Price } from "./cost.js";
import { MAX_INJECTION_DELTA, type CaseResult, type InjectionPair, type Summary } from "./scoring.js";

export interface RunMeta {
  provider: "anthropic" | "recorded";
  model: string;
  startedAt: string;
  maxOutputTokens: number;
  effort: string | null;
  /** --repeats: how many times each case ran. */
  repeats: number;
  price: Price | null;
}

const DASH = "—";
const show = (n: number | null): string => (n === null ? DASH : String(n));
const mark = (ok: boolean): string => (ok ? "✅" : "❌");
const yesNo = (b: boolean | null): string => (b === null ? DASH : b ? "yes" : "no");
/** A table cell: no line breaks, and "|" escaped so it can't split the cell. */
const cell = (text: string): string => text.replace(/\s+/g, " ").replaceAll("|", "\\|");
const usd = (n: number): string => `$${n.toFixed(4)}`;
const seconds = (ms: number | null): string => (ms === null ? DASH : `${(ms / 1000).toFixed(1)} s`);
const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
const VERDICT = { pass: "✅ pass", fail: "❌ fail", inconclusive: "➖ inconclusive" } as const;

function header(meta: RunMeta): string[] {
  if (meta.provider === "recorded") {
    return [
      "# Fit-check evals — dry run",
      "",
      `Run ${meta.startedAt}. **Recorded answers, not a model:** the answers in \`evals/recorded/\` were written by hand ` +
        "to exercise the pipeline (the real tools, quote check and scores). These numbers say nothing about any model.",
    ];
  }
  const price = meta.price ? `$${meta.price.inputPerMTok} / $${meta.price.outputPerMTok} per million tokens (input / output)` : "unknown";
  return [
    "# Fit-check evals",
    "",
    `Run ${meta.startedAt} with \`${meta.model}\`, max_tokens ${meta.maxOutputTokens}, effort ${meta.effort ?? "model default"}, ` +
      `${meta.repeats} run(s) per case. Prices assumed: ${price} (evals/src/cost.ts).`,
  ];
}

/** One row per case, one column per criterion label (first-seen order); [] when no case saved criteria. */
function criteriaTable(meta: RunMeta, results: readonly CaseResult[]): string[] {
  const labels = [...new Set(results.flatMap((r) => r.criteria.map((c) => c.label)))];
  if (labels.length === 0) return [];
  return [
    "## Criteria per case",
    "",
    "Each criterion's status in the saved fit check (— when the case saved none).",
    "",
    row(["Case", ...labels.map(cell)]),
    row(Array<string>(labels.length + 1).fill("---")),
    ...results.map((r) =>
      row([
        meta.repeats > 1 ? `${r.id} (run ${r.repeat})` : r.id,
        ...labels.map((label) => r.criteria.find((c) => c.label === label)?.status ?? DASH),
      ]),
    ),
    "",
  ];
}

export function renderMarkdown(meta: RunMeta, results: readonly CaseResult[], pairs: readonly InjectionPair[], summary: Summary): string {
  const q = summary.quotes;
  const sg = summary.suggestions;
  const inj = summary.injection;
  const injectionMark = inj.pairs === 0 || inj.failed > 0 ? "❌" : inj.inconclusive > 0 ? "➖" : "✅";
  const injectionNote = `${inj.inconclusive > 0 ? `${inj.inconclusive} inconclusive, ` : ""}largest move ${show(inj.maxAbsDelta)}`;
  const ex = summary.expectations;
  const ff = summary.falseFlags;
  const lines = [
    ...header(meta),
    "",
    "## Summary",
    "",
    row(["Check", "Result", "Target"]),
    row(["---", "---", "---"]),
    row(["Recommendation in expected range", `${summary.inRange}/${summary.cases}`, "as many as possible"]),
    row([
      `Injection resistance (JD % and criteria % move ≤ ${MAX_INJECTION_DELTA} points, same recommendation)`,
      `${inj.passed}/${inj.pairs} pairs ${injectionMark} (${injectionNote})`,
      "100%",
    ]),
    row([
      "Quote faithfulness (stored quotes found word for word)",
      `${q.verified}/${q.kept} (${show(q.verifiedPct)}%) ${mark(q.verifiedPct === 100)}`,
      "100%",
    ]),
    row([
      "Expected criteria statuses held (cases that name them)",
      `${ex.held}/${ex.checked} ${ex.checked === 0 ? DASH : mark(ex.held === ex.checked)}`,
      "all",
    ]),
    row([
      "Ordinary posting lines reported as an injection (cases that check it)",
      `${ff.flagged}/${ff.checked} ${ff.checked === 0 ? DASH : mark(ff.flagged === 0)}`,
      "0",
    ]),
    row(["Raw quote drop rate", `${q.dropped}/${q.kept + q.dropped} (${show(q.dropRatePct)}%)`, "measured"]),
    row([
      "Suggestion quotes found (kept make_explicit quotes in the résumé word for word; not proof the suggestion follows)",
      `${sg.verified}/${sg.kept} (${show(sg.verifiedPct)}%) ${sg.kept === 0 ? DASH : mark(sg.verifiedPct === 100)}`,
      "100%",
    ]),
    row(["Make-explicit suggestions dropped by the quote check", String(sg.dropped), "measured"]),
    row(["Negation slips (known limit L1)", String(summary.negationSlips), "measured"]),
    row(["Fit checks saved", `${summary.saved}/${summary.cases}`, "all"]),
    row(["Tokens (input / output)", `${summary.inputTokens} / ${summary.outputTokens}`, DASH]),
    row(["Cost", usd(summary.costUsd), DASH]),
    row(["Latency per case (median / max)", `${seconds(summary.latencyP50Ms)} / ${seconds(summary.latencyMaxMs)}`, DASH]),
    "",
    "## Cases",
    "",
    row(["Case", "Kind", "Expected", "Got", "In range", "JD %", "Strict % (employer view)", "Criteria %", "Quotes kept / dropped", "Suggestions kept / dropped", "Negation slips", "Attempts", "Tokens in / out", "Latency", "Cost", "Notes"]),
    row(Array<string>(16).fill("---")),
    ...results.map((r) =>
      row([
        meta.repeats > 1 ? `${r.id} (run ${r.repeat})` : r.id,
        r.kind,
        r.expected.join(" / "),
        r.recommendation ?? DASH,
        mark(r.inRange),
        show(r.jdPct),
        show(r.strictPct),
        show(r.criteriaPct),
        `${r.quotesKept} / ${r.quotesDropped}`,
        `${r.suggestionsKept} / ${r.suggestionsDropped}`,
        r.negationSlips.length === 0 ? "0" : cell(r.negationSlips.map((s) => `"${s}"`).join(", ")),
        String(r.attempts),
        `${r.inputTokens} / ${r.outputTokens}`,
        seconds(r.latencyMs),
        usd(r.costUsd),
        cell(r.error ? `${r.title}. Error: ${r.error}` : r.title),
      ]),
    ),
    "",
    "## Prompt injection: each attack against its clean twin",
    "",
    meta.repeats > 1
      ? `Each side is the median of ${meta.repeats} runs; recommendations are compared by their counts, and a tied most-common answer with different counts is inconclusive. "Runs" counts the saved ones.`
      : "One run per side.",
    "",
    row(["Attack", "Twin", "Runs (clean / attack)", "Clean JD %", "Attack JD %", "Δ JD", "Clean criteria %", "Attack criteria %", "Δ criteria", "Recommendation changed", "Verdict", "Flagged in red_flags", "Criteria changed (clean → attack)"]),
    row(Array<string>(13).fill("---")),
    ...pairs.map((p) => {
      // Flagged runs / attack runs (rework L2): "yes" hid a 1-of-3.
      const attackRuns = results.filter((r) => r.id === p.id && r.flaggedInjection !== null);
      const flagged = `${attackRuns.filter((r) => r.flaggedInjection === true).length}/${attackRuns.length}`;
      return row([
        p.id,
        p.twinOf,
        `${p.runs.clean} / ${p.runs.injected}`,
        show(p.cleanJdPct),
        show(p.injectedJdPct),
        show(p.delta),
        show(p.cleanCriteriaPct),
        show(p.injectedCriteriaPct),
        show(p.criteriaDelta),
        yesNo(p.recommendationChanged),
        VERDICT[p.verdict],
        flagged,
        p.criteriaChanges.length === 0 ? "none" : cell(p.criteriaChanges.map((c) => `${c.label}: ${c.clean} → ${c.injected}`).join("; ")),
      ]);
    }),
    "",
    ...criteriaTable(meta, results),
  ];
  return lines.join("\n");
}
