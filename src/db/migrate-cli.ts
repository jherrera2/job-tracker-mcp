// `npm run db:migrate` runs this file: connect with DATABASE_URL, apply pending migrations, exit.
// A real (runtime) import: this file creates a pg.Client. pg is an older CommonJS package, so it is
// imported as one default object and used as pg.Client (compare `import type pg` in migrate.ts).
import pg from "pg";
import { loadDatabaseConfig } from "../config.js";
import { explainDatabaseError } from "./db-errors.js";
import { migrate } from "./migrate.js";

// Setting process.exitCode (instead of calling process.exit(1)) lets Node finish cleanly:
// pending output is flushed and connections close, then the process exits with that code.
try {
  // Only DATABASE_URL is needed here, so an unrelated bad setting (e.g. the AI key) can't block migrations.
  const { databaseUrl } = loadDatabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const applied = await migrate(client);
    console.log(applied.length === 0 ? "Database is up to date." : `Applied: ${applied.join(", ")}`);
  } catch (err) {
    console.error(explainDatabaseError(err, databaseUrl));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined); // already closed if connect() failed
  }
} catch (err) {
  // Config errors: already short, fixed sentences (see src/config.ts).
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
