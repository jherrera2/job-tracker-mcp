// `npm run db:seed` runs this file: connect with DATABASE_URL, apply pending migrations (so one
// command works on a brand-new database), then add the fictional demo (src/demo/seed.ts) and exit.
// Same shape and error handling as src/db/migrate-cli.ts.
//
// Migrations are applied (and listed) even when the seed then refuses: they are not demo data.
// Exit code 0: seeded, or the demo was already there. Exit code 1: the database holds the user's
// own data (no demo data was added), or something failed.
import pg from "pg";
import { loadDatabaseConfig } from "../config.js";
import { explainDatabaseError } from "../db/db-errors.js";
import { migrate } from "../db/migrate.js";
import { seedDemo } from "./seed.js";

try {
  const { databaseUrl } = loadDatabaseConfig();
  // One connection, not a pool: the seed's transaction and table locks belong to one connection.
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const applied = await migrate(client);
    if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);
    const outcome = await seedDemo(client, { databaseUrl });
    if (outcome.status === "refused") {
      console.error(outcome.message);
      process.exitCode = 1;
    } else {
      console.log(outcome.message);
    }
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
