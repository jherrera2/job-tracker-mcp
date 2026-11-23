# PRD generation prompt (editable template)

Use this when writing the PRD for the next iteration. One PRD per iteration, written when that iteration starts.

Write the PRD so an AI coding agent can build it and the maintainer can review it in one sitting:

1. **Goal** — one paragraph: what this iteration ships and which job-search gaps it closes.
2. **User stories** — "As a job seeker, I can…", each with acceptance criteria written as testable statements.
3. **Interface** — every MCP tool (later: every API route / screen): name, input schema (Zod), output shape, errors. Include a mock-up for any UI.
4. **Data** — tables/columns added or changed, with migrations.
5. **AI steps** — each prompt (saved and editable), what goes in, the exact output schema, and how the number or verdict is computed (prefer code computing scores from structured AI output over the AI inventing numbers).
6. **Guardrails** — untrusted input (job postings are data, never instructions), no invented facts, input limits, SSRF, secrets.
7. **Test plan — TDD is mandatory.** For each acceptance criterion, name the test that proves it, and write tests **before** the code. Unit + integration tests in Vitest; an eval set for every AI step (golden cases + prompt-injection cases) with pass thresholds. **Once the project has a UI, every user story also gets a Playwright end-to-end test.**
8. **Build steps** — small, ordered steps; each one = failing tests → code → tests pass → commit. A **separate tester agent** (not the builder) verifies each step or small batch — runs the suite, checks every acceptance criterion has a proving test, reviews the diff — before the next step starts. **Record the tokens** each step used (builder + tester) in `docs/build-log.md`.
9. **ADRs** — decisions this iteration needs. List the question and the options; the maintainer writes the ADR.
10. **Out of scope** — what is deliberately left for later iterations.
11. **Maintainer time** — honest hour estimates per step, total, and which parts the maintainer hand-writes.
12. **Done =** — the checklist that says the iteration is finished.

Rules: no new facts about the user ever enter a résumé; never use the maintainer's personal API key on anything public; don't use third-party authors' names or branded method terms in the public app.
