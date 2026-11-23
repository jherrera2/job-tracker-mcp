// Turns node-postgres errors into one short sentence a person can act on.
//
// Why this exists: when nothing listens on the port, pg throws an AggregateError whose
// message is EMPTY (the details are in its inner errors), so printing err.message showed a blank line.
// The URL is only used for its host and port; the password is never put in a message.

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH"]);

/** Reads the `code` property Node puts on network errors (e.g. "ECONNREFUSED"), if there is one. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

function isUnreachable(err: unknown): boolean {
  const code = errorCode(err);
  if (code && UNREACHABLE_CODES.has(code)) return true;
  // An AggregateError carries one inner error per address tried (IPv6 and IPv4).
  return err instanceof AggregateError && err.errors.some(isUnreachable);
}

function hostAndPort(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || "5432"}`;
  } catch {
    return "the DATABASE_URL host";
  }
}

export function explainDatabaseError(err: unknown, databaseUrl: string): string {
  if (isUnreachable(err)) {
    return `Can't reach Postgres at ${hostAndPort(databaseUrl)}. Is \`docker compose up -d\` running?`;
  }
  // Postgres' own errors (bad SQL, wrong password...) have useful messages that don't include the password.
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  const code = errorCode(err);
  return code ? `Database error (${code}).` : "Unknown database error.";
}
