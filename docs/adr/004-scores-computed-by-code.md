# ADR-004: Scores are computed by code, never asked from the model

- **Status:** Accepted
- **Date:** 2026-11-16

## Context
- The fit check shows a JD match % (plus a strict, employer-view %) and a criteria match %.
- The model returns structured statuses: requirements `met` / `partial` / `missing` (each with a word-for-word quote), criteria `met` / `unclear` / `not_met`.

## Options considered
1. **Ask the model for the percentages.**
2. **The model judges each item; code computes the percentages** in `src/domain/fit-score.ts` (partial = 0.5, strict % counts only `met`, exact half-point math, halves-up rounding).

## Decision
Option 2. "AI judges, code scores." The model's recommendation is never rewritten, but code flags `weak_go` when a `go` has a JD match below 50% after quotes that fail the check are dropped.

## Why
- **AIs are bad at math and inconsistent.** The same job can get 72% one time and 80% the next.
- **Code is testable.** Every score has a test, so the same statuses always give the same number.
- **Every score can be explained.** "3 of 4 met = 75%" instead of "the AI said 75%".

## Consequences
- The weights are fixed: a partial counts as half, and every requirement weighs the same, even though a must-have matters more than a nice-to-have.
