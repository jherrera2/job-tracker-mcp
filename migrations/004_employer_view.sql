-- 004: the employer view (step 11). A second, stricter requirements score beside jd_match_pct, and
-- a count of make_explicit suggestions the quote check dropped.
--
-- strict_jd_match_pct: the share of the posting's requirements with status "met" (partial = 0,
-- missing = 0), computed by code after the quote check (src/domain/fit-score.ts, ADR-004), never
-- read from the model. Modelled on applicant-tracking reviews that sort candidates by "% of
-- criteria met". jd_match_pct is unchanged and stays the main score.
-- suggestions_dropped: how many make_explicit suggestions the word-for-word check removed because
-- their make_explicit_quote is not in the master résumé (the suggestion is dropped, never the
-- requirement). Counted like quotes_dropped.
--
-- The suggestions themselves live where the requirements already are: inside result_json, on each
-- partial requirement (make_explicit, make_explicit_quote), with the dropped ones under
-- result_json.dropped_suggestions, as dropped_quotes are. JSON fields stay Zod-only (DECISIONS).
--
-- Both columns are nullable: NULL = saved before step 11 (old rows load unchanged, and are not
-- backfilled: a strict % recomputed today would not be what that run showed). save_fit always fills both.
ALTER TABLE fit_checks
  ADD COLUMN strict_jd_match_pct numeric(5, 2) CHECK (strict_jd_match_pct BETWEEN 0 AND 100),
  ADD COLUMN suggestions_dropped integer CHECK (suggestions_dropped >= 0);
COMMENT ON COLUMN fit_checks.strict_jd_match_pct IS
  'Employer view: % of requirements "met" (partial and missing count 0), computed by code. NULL = saved before step 11.';
COMMENT ON COLUMN fit_checks.suggestions_dropped IS
  'make_explicit suggestions dropped by the word-for-word quote check. NULL = saved before step 11.';
