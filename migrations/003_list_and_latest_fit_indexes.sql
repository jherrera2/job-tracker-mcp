-- 003: indexes for list_jobs and "the latest fit check" (step 7, review R2).
--
-- list_jobs shows the most recently changed jobs first: ORDER BY updated_at DESC, id DESC, then
-- LIMIT. With this index Postgres reads the first page straight off the index instead of sorting
-- every job (EXPLAIN on 20,000 jobs: 2.3 ms with a sort, 0.07 ms with the index).
CREATE INDEX jobs_updated_at_id_idx ON jobs (updated_at DESC, id DESC);

-- The latest fit check for a job is ORDER BY created_at DESC, id DESC LIMIT 1 (id breaks a tie
-- between two rows saved in one transaction). 001's index stopped at created_at, so Postgres
-- still sorted on id; this one covers the whole order and replaces it.
CREATE INDEX fit_checks_job_latest_idx ON fit_checks (job_id, created_at DESC, id DESC);
DROP INDEX fit_checks_job_id_created_at_idx;
