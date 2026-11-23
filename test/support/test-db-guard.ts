// Safety check for integration tests: they create and drop schemas, so they must only ever
// run against a throwaway database. Kept as a pure function (no I/O) so it can be unit-tested.

/** Returns the database name if `url` points at a database ending in "_test"; throws otherwise. */
export function assertTestDatabaseUrl(url: string): string {
  const parsed = new URL(url);

  // The database name is the URL path ("/jobsearch_test"). The ?query and #fragment are ignored,
  // so a trick like ".../jobsearch?x=_test" doesn't count.
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!dbName.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL must point at a database whose name ends in "_test" (got "${dbName}").`);
  }

  // Refuse query parameters that could ask the driver for a different database.
  for (const key of ["database", "dbname"]) {
    if (parsed.searchParams.has(key)) {
      throw new Error(`TEST_DATABASE_URL must not set "${key}" in its query string.`);
    }
  }
  return dbName;
}
