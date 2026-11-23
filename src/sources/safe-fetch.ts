// The ONLY way this server reads anything from the internet (PRD 01 §6 "No SSRF").
//
// SSRF ("server-side request forgery") is when a user gets the server to fetch an address of
// their choosing, such as a cloud metadata service or a database on the private network. The
// defence here is layered:
// - a fixed allowlist of ATS API hosts; the address is built by our code (src/sources/job-url.ts),
//   never copied from the user, and it is checked again here before every request;
// - HTTPS only, no user name/password or custom port;
// - redirects are not followed automatically: one is followed only to the same host, over HTTPS,
//   at most MAX_REDIRECTS times;
// - a 10-second timeout for the whole exchange (including reading the body) and a cap on the
//   body (2 MB; 8 MB for Ashby), so a slow or huge answer can't tie the server up.
//
// `fetch` is passed in (dependency injection), so tests hand in a fake that answers from recorded
// fixtures and nothing touches the network. The real server uses the global fetch.

/** The global fetch's shape, narrowed to what we use. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export const ALLOWED_API_HOSTS = ["boards-api.greenhouse.io", "api.lever.co", "api.eu.lever.co", "api.ashbyhq.com"] as const;

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Ashby's public API only serves a company's WHOLE board; a real 184-job board was 3.1 MB
// (2026-11-19). So Ashby alone gets 8 MB (chosen: option B); every other host keeps 2 MB.
export const MAX_RESPONSE_BYTES_ASHBY = 8 * 1024 * 1024;

/** The body-size cap for an allowlisted API host. */
export function maxResponseBytesFor(hostname: string): number {
  return hostname === "api.ashbyhq.com" ? MAX_RESPONSE_BYTES_ASHBY : MAX_RESPONSE_BYTES;
}
export const MAX_REDIRECTS = 3;

// Every failure ends in "paste the job description text": the paste fallback always works.
export const SOURCE_MESSAGES = {
  notAllowed: "I can't read that site; paste the job description text.",
  notFound: "I couldn't find that job; it may have closed. Paste the job description text instead.",
  timeout: "The job site took too long to answer. Try again, or paste the job description text.",
  tooLarge: "That job page is too large to read. Paste the job description text instead.",
  unreachable: "I couldn't reach the job site. Try again, or paste the job description text.",
  unreadable: "The job site sent something I couldn't read. Paste the job description text instead.",
  badRedirect: "The job site sent me somewhere I'm not allowed to read. Paste the job description text instead.",
  noDescription: "That job posting has no description I can read. Paste the job description text instead.",
  descriptionTooLong:
    "That job description is over 50,000 characters, too long to check. Paste the part that describes the job.",
} as const;

export const httpErrorMessage = (status: number): string =>
  `The job site answered with an error (HTTP ${status}). Try again later, or paste the job description text.`;

/** A failure reading a job source. The message is a short sentence shown to the user. */
export class JobSourceError extends Error {
  override name = "JobSourceError";
}

/** True for an https URL on an allowlisted host, with no credentials and no custom port. */
export function isAllowedApiUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (ALLOWED_API_HOSTS as readonly string[]).includes(url.hostname) &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export interface FetchJsonOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  maxBytes?: number;
}

/** GETs `url` (an allowlisted API URL) and returns its JSON body. Throws JobSourceError. */
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const doFetch = options.fetch ?? ((u, init) => fetch(u, init));
  let current = parseAllowed(url, SOURCE_MESSAGES.notAllowed);
  // The cap follows the host (redirects never change host, see nextHop). Tests may pass a smaller one.
  const maxBytes = options.maxBytes ?? maxResponseBytesFor(current.hostname);
  // One timer for the whole exchange. AbortController is .NET's CancellationTokenSource.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await request(doFetch, current, controller.signal);
      if (isRedirect(response.status)) {
        discardBody(response);
        current = nextHop(current, response.headers.get("location"), redirects);
        continue;
      }
      if (!response.ok) {
        // Don't leave an error page streaming in: cancel it before failing (the finally aborts too).
        discardBody(response);
        throw new JobSourceError(response.status === 404 ? SOURCE_MESSAGES.notFound : httpErrorMessage(response.status));
      }
      const text = await readCapped(response, maxBytes, controller.signal);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new JobSourceError(SOURCE_MESSAGES.unreadable);
      }
    }
  } finally {
    clearTimeout(timer);
    // Ends anything still open for this exchange (a no-op once the body has been read).
    controller.abort();
  }
}

/**
 * Starts cancelling a body we won't read, so its connection is released, WITHOUT waiting: cancel()
 * can return a promise that never settles (a stuck stream, or an injected fetch), and the abort
 * signal can't interrupt an await on it, so waiting could hang the call past the timeout. A
 * failure to cancel is ignored; the finally in fetchJson also aborts the request.
 */
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

function parseAllowed(url: string, message: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JobSourceError(message);
  }
  if (!isAllowedApiUrl(parsed)) throw new JobSourceError(message);
  return parsed;
}

async function request(doFetch: FetchFn, url: URL, signal: AbortSignal): Promise<Response> {
  try {
    return await doFetch(url.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "application/json", "user-agent": "job-tracker-mcp" },
    });
  } catch (err) {
    if (signal.aborted) throw new JobSourceError(SOURCE_MESSAGES.timeout);
    if (err instanceof JobSourceError) throw err;
    throw new JobSourceError(SOURCE_MESSAGES.unreachable);
  }
}

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);

/** The next URL to fetch: only the same host, over HTTPS, a limited number of times. */
function nextHop(from: URL, location: string | null, redirectsSoFar: number): URL {
  if (!location || redirectsSoFar >= MAX_REDIRECTS) throw new JobSourceError(SOURCE_MESSAGES.badRedirect);
  let next: URL;
  try {
    next = new URL(location, from); // a relative Location is resolved against the current URL
  } catch {
    throw new JobSourceError(SOURCE_MESSAGES.badRedirect);
  }
  if (next.hostname !== from.hostname || !isAllowedApiUrl(next)) {
    throw new JobSourceError(SOURCE_MESSAGES.badRedirect);
  }
  return next;
}

/** Reads the body as UTF-8 text, refusing anything over `maxBytes` and giving up on abort. */
async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discardBody(response);
    throw new JobSourceError(SOURCE_MESSAGES.tooLarge);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  // A promise that rejects when the timer fires, raced against each read. The real fetch also
  // aborts its body on the signal; this makes sure even a body that ignores it can't hang us.
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new JobSourceError(SOURCE_MESSAGES.timeout));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined); // handled by the race below; don't report it as unhandled

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new JobSourceError(SOURCE_MESSAGES.tooLarge);
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => undefined);
    if (err instanceof JobSourceError) throw err;
    throw new JobSourceError(signal.aborted ? SOURCE_MESSAGES.timeout : SOURCE_MESSAGES.unreachable);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
