-- 002: fit checks are written by the user's own chat model, not by a server-side AI call
-- (DECISIONS "ADR-001 decided", 2026-11-19). The server no longer calls the model, so it cannot
-- know which model answered, how long it took, or how many tokens it used.

-- `model` is now whatever the chat app reports to save_fit, if anything: self-reported and
-- unverified. NULL when it reports nothing.
ALTER TABLE fit_checks ALTER COLUMN model DROP NOT NULL;
COMMENT ON COLUMN fit_checks.model IS
  'Model name as reported by the chat client to save_fit; self-reported, not verified. NULL when not reported.';

-- The server never sees the model run, so it has no honest latency to record. Kept (not dropped)
-- for the evals (step 8), which do call a model and can measure it. The >= 0 check stays.
ALTER TABLE fit_checks ALTER COLUMN latency_ms DROP NOT NULL;
COMMENT ON COLUMN fit_checks.latency_ms IS
  'Model latency, only when the caller measured it (evals). NULL for fit checks saved from a chat.';
COMMENT ON COLUMN fit_checks.input_tokens IS 'Only when known (evals); NULL for fit checks saved from a chat.';
COMMENT ON COLUMN fit_checks.output_tokens IS 'Only when known (evals); NULL for fit checks saved from a chat.';

-- Which master résumé version the evidence quotes were checked against. prompt_version already
-- pins the prompt; this pins the other half, so a fit check can always be traced to the exact
-- résumé text its quotes come from. A foreign key, since versions are never deleted.
-- Nullable only so this migration can't fail on a database that already has fit_checks rows
-- (none were ever written before this step); save_fit always fills it.
ALTER TABLE fit_checks
  ADD COLUMN master_resume_version integer REFERENCES master_resume_versions (version);

-- Code-side flags shown BESIDE the model's recommendation, which is stored as the model gave it
-- (DECISIONS, step 6: code never rewrites the recommendation).
-- quotes_dropped: how many evidence quotes the word-for-word check removed.
-- weak_go: the model said "go" but the JD match, after the quote check, is under 50 %.
-- Nullable for the same reason as master_resume_version: NULL = saved before this check existed.
ALTER TABLE fit_checks
  ADD COLUMN quotes_dropped integer CHECK (quotes_dropped >= 0),
  ADD COLUMN weak_go boolean;
