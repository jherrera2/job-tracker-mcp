# Architecture Decision Records

One file per decision that shaped the design. Format: context, the options that were on the table, the decision, and what it costs.

| ADR | Decision | Status |
|---|---|---|
| [001](001-fit-check-by-the-users-chat-model.md) | The user's own chat model writes the fit check; the server makes no AI calls | Accepted 2026-11-19 |
| [002](002-stdio-transport-in-v1.md) | stdio transport in v1, Streamable HTTP later | Accepted 2026-11-16 |
| [003](003-ats-allowlist-and-paste.md) | Job sources: fixed ATS allowlist + paste fallback, no general web fetching | Accepted 2026-11-16 |
| [004](004-scores-computed-by-code.md) | Scores are computed by code from structured output, never asked from the model | Accepted 2026-11-16 |
