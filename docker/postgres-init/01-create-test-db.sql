-- Runs once when the Postgres container is first created (empty volume).
-- Integration tests use this database so they never touch the dev data in "jobsearch".
CREATE DATABASE jobsearch_test;
