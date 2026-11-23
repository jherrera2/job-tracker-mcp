// Runs the real `db:seed` program as a child process against a port where nothing listens, to
// check what the user actually sees. No database needed (the seeding itself is tested in
// test/integration/seed.test.ts).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function runSeedCli(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/demo/seed-cli.ts"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { exitCode: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("db:seed when Postgres is not reachable", () => {
  const unreachable = "postgres://jobsearch:s3cret-pw@localhost:5499/jobsearch";

  it("exits 1 with a clear sentence and never prints the password", () => {
    const { exitCode, output } = runSeedCli({ DATABASE_URL: unreachable });
    expect(exitCode).toBe(1);
    expect(output).toContain("Can't reach Postgres at localhost:5499");
    expect(output).not.toContain("s3cret-pw");
  });

  it("without DATABASE_URL, says which setting is missing", () => {
    const { exitCode, output } = runSeedCli({});
    expect(exitCode).toBe(1);
    expect(output).toContain("DATABASE_URL is missing");
  });
});

describe("package.json", () => {
  it("has a db:seed script with the same .env handling as db:migrate", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["db:seed"]).toBe("tsx --env-file-if-exists=.env src/demo/seed-cli.ts");
    expect(pkg.scripts["db:migrate"]).toContain("--env-file-if-exists=.env");
  });
});
