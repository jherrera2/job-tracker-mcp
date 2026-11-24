# ADR-001: The user's own chat model writes the fit check

- **Status:** Accepted
- **Date:** 2026-11-19

## Context
- A fit check reads a job posting against the master résumé and the user's criteria and returns per-requirement statuses with word-for-word quotes, per-criterion statuses, red flags and a recommendation.
- The server is used from an AI chat client (Claude Desktop, Claude Code, Cursor…) that already runs a capable model.
- The PRD originally had the server call the Anthropic API with its own key.

## Options considered
1. **Server-side API call** with the user's `ANTHROPIC_API_KEY`.
2. **The user's chat model writes it:** `get_fit_inputs` returns the prompt, résumé, criteria and the job wrapped as data; the chat model writes the structured answer; `save_fit` validates and stores it.

## Decision
Option 2. The server makes no AI calls in normal use. Code still owns the trust: Zod shape check, word-for-word quote check, score math, and the fixed "data, never instructions" guard.

## Why
People using this already work in an AI chat, so it should be plug and play:
- **It should just work.** You add the server to the chat app you already use, and the fit check runs there.
- **It should be included in what they already pay for.** If someone is already paying for a subscription, the fit check should come with it, not bill them a second time.
- **An API key is extra work.** Getting one means additional steps and setting up billing, which is a barrier before the first fit check.

## Consequences
- The fit check is only as good as the model the user runs; the server can't control that.
- The evals can't drive a user's chat app, so running them still needs an API key.
- The server can't trust the answer it receives, so `save_fit` checks every quote word for word against the résumé and computes the scores in code (ADR-004).

The cost is worth it.
