// The harness's check on the database it actually reached (its own module so a test can watch
// that main → openHarness really calls it: test/integration/evals-db-guard.test.ts).

/** The database actually reached must be a _test one, whatever the URL said. */
export function assertConnectedToTestDb(name: string | undefined): void {
  if (!name?.endsWith("_test")) throw new Error("Connected to a database that is not a _test database. Stopping.");
}
