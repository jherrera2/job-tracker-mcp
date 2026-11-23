// `npm run evals`: plan, guard, run, score, write. The CLI wrapper is cli.ts; this function takes
// its dependencies as arguments so the tests can drive it without a network.
//
// Order matters for cost safety. Everything before "provider created" is pure and offline:
//   1. read the options and pick the cases (an attack brings its clean twin along);
//   2. size each case's first request offline (the real buildFitPrompt and tool definitions);
//   3. print the case count, model and worst-case cost;
//   4. STOP unless --yes (and refuse if the worst case is above --max-usd or the key is missing);
//   5. only then create the provider, open the throwaway database schema and run.
// A --dry-run uses recorded answers instead (no key, no API, $0).
//
// Exit codes: 0 done (or plan only); 1 failed, stopped early, no case saved, or an injection pair
// failed (an inconclusive pair is printed but exits 0); 2 refused;
// 130 / 143 interrupted (Ctrl-C / SIGTERM), after the eval schema is dropped.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { buildFitPrompt } from "../../src/domain/fit-inputs.js";
import { parsePastedJob } from "../../src/domain/job-paste.js";
import { FIT_CHECK_DEFAULT_PROMPT } from "../../src/domain/prompts.js";
import { readGreenhouseJob } from "../../src/sources/greenhouse.js";
import { detectJobSource } from "../../src/sources/job-url.js";
import { CASES, CRITERIA, NEGATED_CLAIMS } from "../dataset/cases.js";
import type { AnthropicProviderOptions } from "./anthropic-provider.js";
import { LIMITS, parseArgs } from "./args.js";
import { estimateRun, priceFor, type Price } from "./cost.js";
import { greenhouseApiJson, greenhouseJobUrl, readMasterResume, resolveCases, type EvalCase } from "./dataset.js";
import { dropEvalSchema, listModelTools, newEvalSchemaName, openHarness, type Harness } from "./harness.js";
import { RecordedProvider, type ModelProvider } from "./provider.js";
import { redact } from "./redact.js";
import { fitRequest, HARNESS_SYSTEM_PROMPT, runCase } from "./runner.js";
import { injectionPairs, runFailures, scoreCase, summarize, type CaseRun } from "./scoring.js";
import { renderMarkdown, type RunMeta } from "./table.js";

type Signal = "SIGINT" | "SIGTERM";

export interface EvalDeps {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Builds the real provider; only called after the guard passes (cli.ts passes the Anthropic one). */
  createProvider: (options: AnthropicProviderOptions) => ModelProvider;
  recordedDir?: string;
  /** Registers a signal handler and returns its removal. Defaults to process.on / process.off. */
  signals?: { on: (signal: Signal, handler: () => Promise<void>) => () => void };
  /** Ends the process after an interrupt. Defaults to process.exit. Awaited, so a test can look first. */
  exit?: (code: number) => void | Promise<void>;
  /** The throwaway schema's name. Defaults to newEvalSchemaName(); tests pass one to watch it. */
  newSchemaName?: () => string;
}

const RECORDED_DIR = fileURLToPath(new URL("../recorded/", import.meta.url));
const SIGNAL_EXIT: Record<Signal, number> = { SIGINT: 130, SIGTERM: 143 };

const processSignals: NonNullable<EvalDeps["signals"]> = {
  on: (signal, handler) => {
    // The handler catches its own errors; this catch is the last net, so a rejection can't go unhandled.
    const listener = () => {
      handler().catch(() => process.exit(SIGNAL_EXIT[signal]));
    };
    process.on(signal, listener);
    return () => process.off(signal, listener);
  },
};

/** Returns the process exit code (see the top of this file). */
export async function runEvals(argv: readonly string[], deps: EvalDeps): Promise<number> {
  const apiKey = deps.env.ANTHROPIC_API_KEY?.trim() || undefined;
  try {
    return await run(argv, deps, apiKey);
  } catch (error) {
    // Every message is redacted: an SDK or database error may echo a key or URL back.
    deps.err(redact(`Evals stopped: ${error instanceof Error ? error.message : String(error)}`, [apiKey]));
    return 1;
  }
}

async function run(argv: readonly string[], deps: EvalDeps, apiKey: string | undefined): Promise<number> {
  const refuse = (message: string) => {
    deps.err(message);
    return 2;
  };
  const clean = (text: string) => redact(text, [apiKey]);

  // 1. Options and cases.
  const parsed = parseArgs(argv);
  if (!parsed.ok) return refuse(parsed.message);
  const options = parsed.options;
  if (options.dryRun && options.yes) return refuse("--dry-run never calls the API; leave out --yes.");
  const selected = selectCases(resolveCases(CASES), options.caseIds, options.repeats);
  if (!selected.ok) return refuse(selected.message);
  const cases = selected.cases;
  for (const id of selected.added) {
    const attack = cases.find((c) => c.twinOf === id && options.caseIds?.includes(c.id));
    deps.out(`Added ${id}, the clean twin of ${attack?.id ?? "an attack"}: an attack is scored against it.`);
  }
  const resumeText = readMasterResume();
  const runCount = cases.length * options.repeats;
  const runsLabel = options.repeats > 1 ? `${cases.length} × ${options.repeats} runs = ${runCount}` : String(cases.length);

  // 2–5. Plan, guard, provider.
  let provider: ModelProvider;
  let price: Price | null = null;
  let firstRequestChars = new Map<string, number>();
  if (options.dryRun) {
    deps.out(`Dry run: ${runsLabel} cases with recorded answers from evals/recorded/. No API call, no key, $0.`);
    provider = new RecordedProvider(deps.recordedDir ?? RECORDED_DIR);
  } else {
    price = priceFor(options.model) ?? null;
    if (!price) {
      return refuse(`There is no price for model "${options.model}" in evals/src/cost.ts, so its cost can't be estimated. Add it there first.`);
    }
    firstRequestChars = await sizeFirstRequests(cases, resumeText);
    const perRun = cases.flatMap((c) => Array<number>(options.repeats).fill(firstRequestChars.get(c.id) ?? 0));
    const estimate = estimateRun(perRun, { maxOutputTokens: options.maxOutputTokens, maxAttempts: LIMITS.maxAttempts }, price);
    deps.out(
      [
        `Cases: ${runsLabel}`,
        `Model: ${options.model} (effort: ${options.effort ?? "model default"}, max_tokens ${options.maxOutputTokens} per call, up to ${LIMITS.maxAttempts} calls per case)`,
        `Estimated max cost: $${estimate.worstUsd.toFixed(2)} (every call uses every token allowed; ~${estimate.worstInputTokens} input + ${estimate.worstOutputTokens} output tokens)`,
        `Typical cost: about $${estimate.typicalUsd.toFixed(2)} (one call per case, ~2,000 output tokens each)`,
        `Prices assumed: $${price.inputPerMTok} / $${price.outputPerMTok} per million input / output tokens (evals/src/cost.ts)`,
        `Spending limit (--max-usd): $${options.maxUsd.toFixed(2)}`,
      ].join("\n"),
    );
    if (estimate.worstUsd > options.maxUsd) {
      return refuse(
        `Refusing: the worst case ($${estimate.worstUsd.toFixed(2)}) is above --max-usd ($${options.maxUsd.toFixed(2)}). ` +
          `Run fewer cases (--cases), lower --max-output-tokens, or raise --max-usd (at most $${LIMITS.maxUsd}).`,
      );
    }
    if (!options.yes) {
      deps.out("Nothing was sent. To call the API for real, run: npm run evals -- --yes");
      return 0;
    }
    if (!apiKey) return refuse("ANTHROPIC_API_KEY is not set. Put it in .env (never commit it) and run again.");
    provider = deps.createProvider({ apiKey, model: options.model, effort: options.effort });
  }

  // 6. Run every case (× --repeats) against a throwaway schema.
  const databaseUrl = deps.env.EVAL_DATABASE_URL || deps.env.TEST_DATABASE_URL;
  if (!databaseUrl) return refuse("Set TEST_DATABASE_URL (or EVAL_DATABASE_URL) to a database whose name ends in _test.");
  const startedAt = new Date().toISOString();
  const schema = (deps.newSchemaName ?? newEvalSchemaName)();

  // Ctrl-C / SIGTERM (step 8 re-check M3). Registered BEFORE the schema exists and kept until
  // close has finished, so no moment is uncovered. The handler drops the schema on a FRESH
  // connection after terminating the harness's own one (a tool transaction left open there would
  // otherwise keep the schema alive), then exits 130 / 143. A second signal exits at once.
  let interrupted: Signal | null = null;
  let harnessPid: number | undefined;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const signals = deps.signals ?? processSignals;
  const removeHandlers = (["SIGINT", "SIGTERM"] as const).map((signal) =>
    signals.on(signal, async () => {
      if (interrupted) {
        await exit(SIGNAL_EXIT[signal]);
        return;
      }
      interrupted = signal;
      deps.err(`${signal}: dropping the eval schema ${schema} and stopping.`);
      try {
        await dropEvalSchema(databaseUrl, schema, () => harnessPid);
      } catch (error) {
        deps.err(clean(`Could not drop ${schema}: ${error instanceof Error ? error.message : String(error)}`));
      }
      await exit(SIGNAL_EXIT[signal]);
    }),
  );

  const plan = cases.flatMap((evalCase, index) =>
    Array.from({ length: options.repeats }, (_, r) => ({ evalCase, index, repeat: r + 1 })),
  );
  const runs: CaseRun[] = [];
  let stopped: string | null = null;
  let harness: Harness | undefined;
  let runError: Error | null = null;
  try {
    harness = await openHarness({
      databaseUrl,
      schema,
      resumeText,
      criteria: CRITERIA,
      cases,
      onBackendPid: (pid) => (harnessPid = pid),
      cancelled: () => interrupted !== null,
    });
    let spentUsd = 0;
    for (const [n, { evalCase, index, repeat }] of plan.entries()) {
      if (interrupted) break;
      const label = `[${n + 1}/${plan.length}] ${evalCase.id}${options.repeats > 1 ? ` (run ${repeat})` : ""}`;
      // Budget: never start a case whose worst case could take the run over --max-usd.
      if (price && !stopped) {
        const chars = firstRequestChars.get(evalCase.id) ?? 0;
        const worst = estimateRun([chars], { maxOutputTokens: options.maxOutputTokens, maxAttempts: LIMITS.maxAttempts }, price).worstUsd;
        if (spentUsd + worst > options.maxUsd) stopped = "the --max-usd budget was reached";
      }
      if (stopped) {
        runs.push({ caseId: evalCase.id, jobId: null, attempts: [], saved: null, error: `Not run: ${stopped}.`, fatal: false });
        continue;
      }
      const caseRun = await runCase(harness, evalCase, index, provider, {
        maxOutputTokens: options.maxOutputTokens,
        maxCalls: LIMITS.maxAttempts,
        clock: () => performance.now(),
        stopped: () => interrupted !== null,
      });
      if (caseRun.error) caseRun.error = clean(caseRun.error);
      runs.push(caseRun);
      // Counted even when the case failed: a failed call still costs (review R5).
      const scored = scoreCase(evalCase, caseRun, { resumeText, claims: NEGATED_CLAIMS, price }, repeat);
      spentUsd += scored.costUsd;
      if (caseRun.fatal) stopped = `the run stopped: ${caseRun.error ?? "fatal provider error"}`;
      if (interrupted) break;
      if (caseRun.error) deps.err(`${label}: ${caseRun.error}`);
      else deps.out(`${label}: ${scored.recommendation ?? "not saved"} (JD ${scored.jdPct ?? "—"} %) ${scored.inRange ? "in range" : "OUT OF RANGE"}`);
    }
  } catch (error) {
    if (!interrupted) runError = asError(error);
  }
  // After an interrupt the harness connection is gone on purpose (the handler dropped the schema),
  // so a failing close is only an error when nothing was interrupted. The signal handlers stay
  // registered until close has finished.
  const closeError = await (harness?.close() ?? Promise.resolve()).then(
    () => null,
    (error: unknown) => asError(error),
  );
  for (const remove of removeHandlers) remove();
  if (runError) throw runError;
  if (closeError && !interrupted) throw closeError;
  if (interrupted) return SIGNAL_EXIT[interrupted];

  // 7. Score, render, write.
  const results = plan.map(({ evalCase, repeat }, n) =>
    scoreCase(
      evalCase,
      runs[n] ?? { caseId: evalCase.id, jobId: null, attempts: [], saved: null, error: "Not run.", fatal: false },
      { resumeText, claims: NEGATED_CLAIMS, price },
      repeat,
    ),
  );
  const pairs = injectionPairs(results);
  const summary = summarize(results);
  const meta: RunMeta = {
    provider: provider.name,
    model: provider.model,
    startedAt,
    maxOutputTokens: options.maxOutputTokens,
    effort: options.effort,
    repeats: options.repeats,
    price,
  };
  const markdown = renderMarkdown(meta, results, pairs, summary);
  const json = JSON.stringify({ meta: { ...meta, schema, maxUsd: options.maxUsd }, summary, injectionPairs: pairs, results, runs }, null, 2);

  mkdirSync(options.outDir, { recursive: true });
  const base = join(options.outDir, `${startedAt.replaceAll(":", "-")}-${provider.model}`);
  writeFileSync(`${base}.json`, clean(json) + "\n");
  writeFileSync(`${base}.md`, clean(markdown));
  deps.out(clean(markdown));
  deps.out(`Results written to ${base}.json and ${base}.md`);
  if (stopped) return 1; // a run that stopped early is not a complete result
  if (summary.saved === 0) return 1;
  // A failed injection pair, a missed expected criteria status or a false injection flag fails the
  // run (step 12 rework); an inconclusive pair is printed but doesn't.
  const failures = runFailures(summary);
  if (failures.length > 0) {
    for (const failure of failures) deps.err(failure);
    return 1;
  }
  return 0;
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export type CaseSelection = { ok: true; cases: EvalCase[]; added: string[] } | { ok: false; message: string };

/**
 * The cases to run, in dataset order. An attack named without its clean twin brings the twin
 * along (review R3): an attack can only be scored against it. At most LIMITS.maxCases case runs
 * (cases × repeats).
 */
export function selectCases(all: readonly EvalCase[], ids: readonly string[] | null, repeats: number): CaseSelection {
  let cases = [...all];
  const added: string[] = [];
  if (ids) {
    const byId = new Map(all.map((c) => [c.id, c]));
    const unknown = ids.find((id) => !byId.has(id));
    if (unknown !== undefined) return { ok: false, message: `Unknown case "${unknown}". The cases are: ${all.map((c) => c.id).join(", ")}.` };
    const wanted = new Set(ids);
    for (const id of ids) {
      const twin = byId.get(id)?.twinOf;
      if (twin && !wanted.has(twin)) {
        wanted.add(twin);
        added.push(twin);
      }
    }
    cases = all.filter((c) => wanted.has(c.id));
  }
  if (cases.length === 0) return { ok: false, message: "No cases selected." };
  if (cases.length * repeats > LIMITS.maxCases) {
    return {
      ok: false,
      message: `At most ${LIMITS.maxCases} case runs per run (${cases.length} cases × ${repeats} = ${cases.length * repeats}).`,
    };
  }
  return { ok: true, cases, added };
}

/**
 * The characters of each case's FIRST request, sized offline: the system line, the tool
 * definitions, the user's ask, the harness's get_fit_inputs call and its result (the real
 * buildFitPrompt with the shipped prompt, the job as add_job would store it, wrapped in JSON as
 * the tool returns it). Used only for the cost estimate, before anything is opened or sent.
 */
export async function sizeFirstRequests(cases: readonly EvalCase[], resumeText: string): Promise<Map<string, number>> {
  const tools: Anthropic.Tool[] = await listModelTools();
  const fixed = HARNESS_SYSTEM_PROMPT.length + JSON.stringify(tools).length + fitRequest(1).length + 200;
  const sizes = new Map<string, number>();
  for (const evalCase of cases) {
    const prompt = promptFor(evalCase, resumeText);
    // get_fit_inputs' JSON: the prompt (JSON-escaped) plus ref, versions and next_step.
    const toolResult = JSON.stringify({ prompt }).length + 400;
    sizes.set(evalCase.id, fixed + toolResult);
  }
  return sizes;
}

/** The prompt get_fit_inputs would build for this case, offline (the shipped default prompt). */
export function promptFor(evalCase: EvalCase, resumeText: string): string {
  const p = evalCase.posting;
  let job;
  if (p.source === "paste") {
    const pasted = parsePastedJob({ text: p.text, title: p.title, company: p.company });
    if (!pasted.ok) throw new Error(`Case "${evalCase.id}": ${pasted.message}`);
    job = { title: pasted.job.title, company: pasted.job.company, location: null, payText: null, description: pasted.job.text };
  } else {
    const detected = detectJobSource(greenhouseJobUrl(0));
    if (!detected.ok) throw new Error(detected.message);
    job = readGreenhouseJob(greenhouseApiJson(p), detected.source);
  }
  return buildFitPrompt({ promptText: FIT_CHECK_DEFAULT_PROMPT, resumeText, criteria: CRITERIA, job }).text;
}
