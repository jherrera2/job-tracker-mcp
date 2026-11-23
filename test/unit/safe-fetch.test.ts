// The guarded fetch (PRD 01 §6 "No SSRF"): only allowlisted ATS API hosts, HTTPS only, a 10 s
// timeout, a 2 MB response cap and no redirects to other hosts. The real `fetch` is replaced by a
// fake, so these tests never touch the network.
import { describe, expect, it } from "vitest";
import {
  ALLOWED_API_HOSTS,
  FETCH_TIMEOUT_MS,
  JobSourceError,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES_ASHBY,
  SOURCE_MESSAGES,
  httpErrorMessage,
  maxResponseBytesFor,
  fetchJson,
  type FetchFn,
} from "../../src/sources/safe-fetch.js";
import { fakeFetch } from "../support/fake-fetch.js";

const API = "https://api.lever.co/v0/postings/acme/5f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

/** A fetch that must never be called. */
const noFetch: FetchFn = () => {
  throw new Error("fetch must not be called");
};

async function failure(promise: Promise<unknown>): Promise<JobSourceError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof JobSourceError) return err;
    throw err;
  }
  throw new Error("expected a JobSourceError");
}

/** A body stream that sends `chunks` and then, if `hang`, never finishes. */
function streamOf(chunks: Uint8Array[], hang = false): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else if (!hang) controller.close();
      // when hanging: enqueue nothing and never close
      return hang && !chunk ? new Promise(() => undefined) : undefined;
    },
  });
}

describe("limits", () => {
  it("uses the PRD's numbers", () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
    expect(MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
    expect([...ALLOWED_API_HOSTS].sort()).toEqual(
      ["api.ashbyhq.com", "api.eu.lever.co", "api.lever.co", "boards-api.greenhouse.io"].sort(),
    );
  });
});

describe("fetchJson — which addresses it will fetch", () => {
  it.each([
    "http://api.lever.co/v0/postings/acme/1",
    "https://example.com/x",
    "https://api.lever.co.evil.example/x",
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost/x",
    "https://api.lever.co:8443/x",
    "https://user:pass@api.lever.co/x",
    // User name alone and password alone: each check is proven on its own.
    "https://user@api.lever.co/x",
    "https://:pw@api.lever.co/x",
    "not a url",
  ])("refuses %s without making a request", async (url) => {
    const err = await failure(fetchJson(url, { fetch: noFetch }));
    expect(err.message).toBe(SOURCE_MESSAGES.notAllowed);
  });

  it("returns the parsed JSON from an allowlisted HTTPS host", async () => {
    const fake = fakeFetch({ [API]: { body: '{"text":"Data Engineer"}' } });
    await expect(fetchJson(API, { fetch: fake.fetch })).resolves.toEqual({ text: "Data Engineer" });
    expect(fake.calls).toEqual([API]);
  });

  it("asks fetch not to follow redirects by itself, and passes an abort signal", async () => {
    const fake = fakeFetch({ [API]: { body: "{}" } });
    await fetchJson(API, { fetch: fake.fetch });
    expect(fake.inits[0]?.redirect).toBe("manual");
    expect(fake.inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchJson — answers that are not a job", () => {
  it("404 → the job may have closed", async () => {
    const err = await failure(fetchJson(API, { fetch: fakeFetch({}).fetch }));
    expect(err.message).toBe(SOURCE_MESSAGES.notFound);
    expect(err.message).toBe("I couldn't find that job; it may have closed. Paste the job description text instead.");
  });

  it("another error status → names the status, suggests trying again", async () => {
    const fake = fakeFetch({ [API]: { status: 503, body: "busy" } });
    const err = await failure(fetchJson(API, { fetch: fake.fetch }));
    expect(err.message).toBe(
      "The job site answered with an error (HTTP 503). Try again later, or paste the job description text.",
    );
  });

  it.each([404, 503])("on HTTP %i, cancels the unread body and aborts the request before failing", async (status) => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const answer: FetchFn = (_url, init) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(new Response(body, { status }));
    };
    await failure(fetchJson(API, { fetch: answer }));
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("a body that is not JSON → unreadable", async () => {
    const fake = fakeFetch({ [API]: { body: "<html>hello</html>" } });
    expect((await failure(fetchJson(API, { fetch: fake.fetch }))).message).toBe(SOURCE_MESSAGES.unreadable);
  });

  it("a network failure → can't reach", async () => {
    const broken: FetchFn = () => Promise.reject(new TypeError("fetch failed"));
    expect((await failure(fetchJson(API, { fetch: broken }))).message).toBe(SOURCE_MESSAGES.unreachable);
  });
});

describe("fetchJson — timeout", () => {
  it("gives up when the site does not answer in time", async () => {
    // Like the real fetch: the promise settles only when the signal aborts.
    const silent: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const err = await failure(fetchJson(API, { fetch: silent, timeoutMs: 30 }));
    expect(err.message).toBe(SOURCE_MESSAGES.timeout);
  });

  it("also gives up when the body stops arriving half-way", async () => {
    const stalls: FetchFn = () =>
      Promise.resolve(new Response(streamOf([new TextEncoder().encode('{"a":')], true), { status: 200 }));
    const err = await failure(fetchJson(API, { fetch: stalls, timeoutMs: 30 }));
    expect(err.message).toBe(SOURCE_MESSAGES.timeout);
  });
});

describe("fetchJson — size cap", () => {
  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    let pulled = false;
    // highWaterMark 0: the stream only pulls when someone reads (by default it pre-fills one chunk).
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const big: FetchFn = () =>
      Promise.resolve(new Response(body, { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    const err = await failure(fetchJson(API, { fetch: big }));
    expect(err.message).toBe(SOURCE_MESSAGES.tooLarge);
    expect(pulled).toBe(false);
  });

  it("stops reading a body (with no Content-Length) once it passes the cap", async () => {
    const chunk = new Uint8Array(1024).fill(0x20);
    const endless: FetchFn = () =>
      Promise.resolve(new Response(streamOf(Array.from({ length: 10 }, () => chunk)), { status: 200 }));
    const err = await failure(fetchJson(API, { fetch: endless, maxBytes: 4 * 1024 }));
    expect(err.message).toBe(SOURCE_MESSAGES.tooLarge);
  });

  it("accepts a body exactly at the cap", async () => {
    const body = `"${"a".repeat(98)}"`; // 100 bytes of JSON
    const fake = fakeFetch({ [API]: { body } });
    await expect(fetchJson(API, { fetch: fake.fetch, maxBytes: 100 })).resolves.toBe("a".repeat(98));
  });
});

describe("fetchJson — redirects", () => {
  const redirectTo = (location: string, status = 302) => ({ status, headers: { location } });

  it.each([
    "https://example.com/x",
    "https://169.254.169.254/latest/meta-data/",
    "http://api.lever.co/v0/postings/acme/other",
    "https://api.ashbyhq.com/posting-api/job-board/acme",
  ])("does not follow a redirect to %s", async (location) => {
    const fake = fakeFetch({ [API]: redirectTo(location) });
    const err = await failure(fetchJson(API, { fetch: fake.fetch }));
    expect(err.message).toBe(SOURCE_MESSAGES.badRedirect);
    expect(fake.calls).toEqual([API]);
  });

  it("follows a redirect on the same host (relative or absolute)", async () => {
    const moved = "https://api.lever.co/v0/postings/acme/moved";
    const fake = fakeFetch({
      [API]: redirectTo("/v0/postings/acme/step", 301),
      "https://api.lever.co/v0/postings/acme/step": redirectTo(moved, 307),
      [moved]: { body: '{"ok":true}' },
    });
    await expect(fetchJson(API, { fetch: fake.fetch })).resolves.toEqual({ ok: true });
    expect(fake.calls).toHaveLength(3);
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    const loop = fakeFetch({ [API]: redirectTo(API) });
    const err = await failure(fetchJson(API, { fetch: loop.fetch }));
    expect(err.message).toBe(SOURCE_MESSAGES.badRedirect);
    expect(loop.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("treats a redirect with no Location as an error", async () => {
    const fake = fakeFetch({ [API]: { status: 302 } });
    expect((await failure(fetchJson(API, { fetch: fake.fetch }))).message).toBe(SOURCE_MESSAGES.badRedirect);
  });
});

describe("fetchJson — the size cap depends on the host (chosen: option B)", () => {
  const ASHBY = "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true";
  const GREENHOUSE = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/1?pay_transparency=true";
  const MB = 1024 * 1024;

  it("is 8 MB for Ashby's API and 2 MB for every other host", () => {
    expect(MAX_RESPONSE_BYTES_ASHBY).toBe(8 * MB);
    expect(maxResponseBytesFor("api.ashbyhq.com")).toBe(8 * MB);
    expect(maxResponseBytesFor("boards-api.greenhouse.io")).toBe(2 * MB);
    expect(maxResponseBytesFor("api.lever.co")).toBe(2 * MB);
    expect(maxResponseBytesFor("api.eu.lever.co")).toBe(2 * MB);
  });

  /** A JSON string body of exactly `bytes` bytes. */
  const jsonOfBytes = (bytes: number) => `"${"a".repeat(bytes - 2)}"`;

  // Streamed: no Content-Length, so the cap is enforced while reading.
  it.each([
    [GREENHOUSE, 2 * MB, true],
    [GREENHOUSE, 2 * MB + 1, false],
    [API, 2 * MB + 1, false],
    [ASHBY, 3 * MB, true],
    [ASHBY, 8 * MB, true],
    [ASHBY, 8 * MB + 1, false],
  ])("streamed body from %s of %i bytes → accepted: %s", async (url, bytes, accepted) => {
    const fake = fakeFetch({ [url]: { body: jsonOfBytes(bytes) } });
    const result = fetchJson(url, { fetch: fake.fetch });
    if (accepted) await expect(result).resolves.toHaveLength(bytes - 2);
    else expect((await failure(result)).message).toBe(SOURCE_MESSAGES.tooLarge);
  });

  // Declared: a Content-Length over the host's cap is refused before reading.
  it.each([
    [GREENHOUSE, 2 * MB + 1],
    [API, 2 * MB + 1],
    [ASHBY, 8 * MB + 1],
  ])("declared Content-Length from %s of %i bytes is refused", async (url, bytes) => {
    const fake = fakeFetch({ [url]: { body: "{}", headers: { "content-length": String(bytes) } } });
    expect((await failure(fetchJson(url, { fetch: fake.fetch }))).message).toBe(SOURCE_MESSAGES.tooLarge);
  });

  it("a declared 3 MB from Ashby is within its cap", async () => {
    const body = jsonOfBytes(3 * MB);
    const fake = fakeFetch({ [ASHBY]: { body, headers: { "content-length": String(3 * MB) } } });
    await expect(fetchJson(ASHBY, { fetch: fake.fetch })).resolves.toHaveLength(3 * MB - 2);
  });
});

describe("fetchJson — a body whose cancel() never settles can't hang the call", () => {
  // Copilot (PR #4): awaiting body.cancel() waits forever if cancel() never settles (an injected
  // fetch, or a stuck stream), and the abort signal can't interrupt that await.
  const stuckBody = () =>
    new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => undefined) }, { highWaterMark: 0 });

  const settlesWithin = async (promise: Promise<unknown>, ms: number): Promise<unknown> =>
    Promise.race([
      promise.then(
        () => "resolved",
        (err: unknown) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), ms)),
    ]);

  it.each([
    ["404", 404, {}, SOURCE_MESSAGES.notFound],
    ["503", 503, {}, httpErrorMessage(503)],
    ["a redirect to another host", 302, { location: "https://example.com/x" }, SOURCE_MESSAGES.badRedirect],
    ["a declared size over the cap", 200, { "content-length": String(MAX_RESPONSE_BYTES + 1) }, SOURCE_MESSAGES.tooLarge],
  ])("%s → still rejects promptly", async (_name, status, headers, message) => {
    const answer: FetchFn = () => Promise.resolve(new Response(stuckBody(), { status, headers }));
    const outcome = await settlesWithin(fetchJson(API, { fetch: answer, timeoutMs: 200 }), 1_000);
    expect(outcome).toBeInstanceOf(JobSourceError);
    expect((outcome as Error).message).toBe(message);
  });
});
